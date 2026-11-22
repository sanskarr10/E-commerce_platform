import json
import uuid

import pytest
from sqlalchemy import func, select

from app.events.consumer import PermanentError
from app.events.handlers import handle_event
from app.models import Inbox, Outbox, Payment
from app.provider import ProviderUnavailable
from tests.support import SessionLocal, requested


def run(provider, envelope):
    return handle_event(SessionLocal, provider, envelope)


def events(db):
    db.expire_all()
    rows = db.execute(select(Outbox).order_by(Outbox.seq)).scalars().all()
    parsed = [json.loads(r.payload) for r in rows]
    db.commit()  # end the read transaction so it cannot hold a lock (SQLite) while handlers write
    return parsed


def payment_for(db, order_id):
    db.expire_all()
    payment = db.execute(select(Payment).where(Payment.order_id == order_id)).scalar_one()
    db.commit()
    return payment


class TestOutcomes:
    def test_success_saves_the_payment_and_announces_it(self, db, provider):
        order_id = uuid.uuid4()
        assert run(provider, requested(order_id)) == "succeeded"
        payment = payment_for(db, order_id)
        assert (payment.status, payment.amount_minor, payment.currency) == (
            "SUCCEEDED",
            249900,
            "INR",
        )
        assert payment.provider_ref.startswith("ch_")
        [event] = events(db)
        assert event["type"] == "payment.succeeded"
        assert event["correlation_id"] == str(order_id)
        assert event["data"] == {
            "order_id": str(order_id),
            "payment_id": str(payment.id),
            "amount_minor": 249900,
            "currency": "INR",
        }

    @pytest.mark.parametrize(
        ("token", "reason"),
        [
            ("tok_decline", "card_declined"),
            ("tok_insufficient", "insufficient_funds"),
            ("tok_nonsense", "invalid_payment_method"),
        ],
    )
    def test_decline_saves_the_reason_and_announces_failure(self, db, provider, token, reason):
        order_id = uuid.uuid4()
        assert run(provider, requested(order_id, token)) == "failed"
        payment = payment_for(db, order_id)
        assert (payment.status, payment.failure_reason, payment.provider_ref) == (
            "FAILED",
            reason,
            None,
        )
        [event] = events(db)
        assert event["type"] == "payment.failed"
        assert event["data"] == {
            "order_id": str(order_id),
            "payment_id": str(payment.id),
            "reason": reason,
        }
        assert provider.approved_charges == 0

    def test_the_payment_method_token_never_appears_in_events(self, db, provider):
        run(provider, requested(method="tok_success"))
        assert "tok_success" not in json.dumps(events(db))


class TestTransientFailures:
    def test_provider_outage_raises_for_retry_and_leaves_a_pending_payment_with_no_event(
        self, db, provider
    ):
        order_id = uuid.uuid4()
        with pytest.raises(ProviderUnavailable):
            run(provider, requested(order_id, "tok_error"))
        assert payment_for(db, order_id).status == "PENDING"
        assert events(db) == []
        assert db.scalar(select(func.count()).select_from(Inbox)) == 0, (
            "so the redelivery is processed"
        )

    def test_flaky_provider_succeeds_on_redelivery_with_the_same_payment(self, db, provider):
        order_id, event = uuid.uuid4(), requested(uuid.uuid4(), "tok_flaky")
        order_id = uuid.UUID(event.data["order_id"])
        with pytest.raises(ProviderUnavailable):
            run(provider, event)
        pending_id = payment_for(db, order_id).id
        assert run(provider, event) == "succeeded"
        payment = payment_for(db, order_id)
        assert payment.id == pending_id and payment.status == "SUCCEEDED"
        assert [e["type"] for e in events(db)] == ["payment.succeeded"]
        assert provider.approved_charges == 1

    def test_crash_after_charge_before_saving_does_not_charge_twice(
        self, db, provider, monkeypatch
    ):
        """Provider approved, then the process died before step 3. The retry reuses the payment id."""
        event = requested()
        order_id = uuid.UUID(event.data["order_id"])
        import app.events.handlers as handlers

        real_claim = handlers._claim
        monkeypatch.setattr(
            handlers, "_claim", lambda *a: (_ for _ in ()).throw(RuntimeError("crash"))
        )
        with pytest.raises(RuntimeError):
            run(provider, event)
        assert provider.approved_charges == 1
        assert payment_for(db, order_id).status == "PENDING"
        assert events(db) == []

        monkeypatch.setattr(handlers, "_claim", real_claim)
        assert run(provider, event) == "succeeded"
        assert provider.approved_charges == 1, "the customer was charged exactly once"
        assert [e["type"] for e in events(db)] == ["payment.succeeded"]


class TestIdempotency:
    def test_same_event_twice_charges_and_emits_once(self, db, provider):
        event = requested()
        assert run(provider, event) == "succeeded"
        assert run(provider, event) == "duplicate"
        assert provider.approved_charges == 1
        assert len(events(db)) == 1

    def test_second_event_for_the_same_order_does_not_charge_again(self, db, provider):
        order_id = uuid.uuid4()
        assert run(provider, requested(order_id)) == "succeeded"
        assert run(provider, requested(order_id)) == "already_processed"
        assert provider.approved_charges == 1
        assert len(events(db)) == 1
        assert db.scalar(select(func.count()).select_from(Payment)) == 1

    def test_conflicting_terms_on_a_repeat_request_never_change_the_charge(
        self, db, provider, caplog
    ):
        order_id = uuid.uuid4()
        run(provider, requested(order_id))
        with caplog.at_level("ERROR"):
            run(provider, requested(order_id, amount_minor=1))
        assert "different terms" in caplog.text
        assert payment_for(db, order_id).amount_minor == 249900

    def test_a_declined_order_is_not_retried_by_a_new_event(self, db, provider):
        order_id = uuid.uuid4()
        run(provider, requested(order_id, "tok_decline"))
        assert run(provider, requested(order_id, "tok_success")) == "already_processed"
        assert provider.approved_charges == 0
        assert [e["type"] for e in events(db)] == ["payment.failed"]


class TestBadInput:
    @pytest.mark.parametrize(
        "bad",
        [
            {"amount_minor": 0},
            {"amount_minor": -5},
            {"currency": "inr"},
            {"currency": "RUPEES"},
            {"payment_method": ""},
        ],
    )
    def test_contract_violations_are_permanent(self, provider, bad):
        with pytest.raises(PermanentError, match="invalid payment.requested"):
            run(provider, requested(**bad))
        assert provider.approved_charges == 0

    def test_missing_fields_are_permanent(self, provider):
        event = requested()
        del event.data["user_id"]
        with pytest.raises(PermanentError):
            run(provider, event)

    def test_other_event_types_are_ignored(self, provider):
        event = requested()
        event.type = "order.created"
        assert run(provider, event) == "unknown_type"
