import json
import uuid

import pytest
from sqlalchemy import func, select

from app.events.consumer import PermanentError
from app.events.handlers import handle_event
from app.events.schemas import Envelope
from app.models import Inbox, Order, Outbox
from tests.support import fixture, insert_order


def event(kind: str, order, **data) -> Envelope:
    """A fixture-shaped envelope for `order`, with a fresh event id."""
    raw = fixture(kind)
    raw["id"] = str(uuid.uuid4())
    raw["correlation_id"] = str(order.id)
    defaults = {"order_id": str(order.id)}
    if (
        kind == "payment.succeeded"
    ):  # a well-behaved payment service charges exactly the order total
        defaults |= {"amount_minor": order.total_minor, "currency": order.currency}
    raw["data"] = {**raw["data"], **defaults, **data}
    return Envelope.model_validate(raw)


def outbox_types(db):
    db.expire_all()
    return [r.event_type for r in db.execute(select(Outbox).order_by(Outbox.seq)).scalars()]


def status_of(db, order) -> str:
    db.expire_all()
    return db.get(Order, order.id).status


class TestStockReserved:
    def test_pending_order_moves_on_and_requests_payment(self, db):
        order = insert_order("PENDING")
        assert handle_event(db, event("stock.reserved", order)) == "payment_requested"
        assert status_of(db, order) == "STOCK_RESERVED"
        row = db.execute(select(Outbox)).scalar_one()
        payload = json.loads(row.payload)
        assert row.event_type == "payment.requested"
        assert payload["data"] == {
            "order_id": str(order.id),
            "user_id": str(order.user_id),
            "amount_minor": 369700,
            "currency": "INR",
            "payment_method": "tok_success",
        }
        assert payload["correlation_id"] == str(order.id)

    def test_cancelled_order_makes_the_product_service_let_go(self, db):
        order = insert_order("CANCELLED", cancel_reason="payment_failed")
        assert handle_event(db, event("stock.reserved", order)) == "re_emitted_cancel"
        assert outbox_types(db) == ["order.cancelled"]
        assert status_of(db, order) == "CANCELLED"

    @pytest.mark.parametrize("status", ["STOCK_RESERVED", "PAID", "SHIPPED", "DELIVERED"])
    def test_later_states_ignore_it(self, db, status):
        order = insert_order(status)
        assert handle_event(db, event("stock.reserved", order)) == "ignored"
        assert status_of(db, order) == status
        assert outbox_types(db) == []


class TestStockFailed:
    def test_cancels_with_out_of_stock_and_announces_it(self, db):
        order = insert_order("PENDING")
        assert handle_event(db, event("stock.failed", order)) == "cancelled"
        db.expire_all()
        refreshed = db.get(Order, order.id)
        assert (refreshed.status, refreshed.cancel_reason) == ("CANCELLED", "out_of_stock")
        assert outbox_types(db) == ["order.cancelled"]
        assert (
            json.loads(db.execute(select(Outbox)).scalar_one().payload)["data"]["reason"]
            == "out_of_stock"
        )

    @pytest.mark.parametrize("status", ["STOCK_RESERVED", "PAID", "CANCELLED"])
    def test_ignored_unless_pending(self, db, status):
        order = insert_order(status)
        assert handle_event(db, event("stock.failed", order)) == "ignored"
        assert status_of(db, order) == status


class TestPayment:
    def test_success_marks_paid_and_confirms(self, db):
        order = insert_order("STOCK_RESERVED")
        assert handle_event(db, event("payment.succeeded", order)) == "paid"
        assert status_of(db, order) == "PAID"
        confirmed = json.loads(db.execute(select(Outbox)).scalar_one().payload)
        assert confirmed["type"] == "order.confirmed"
        assert confirmed["data"] == {
            "order_id": str(order.id),
            "user_id": str(order.user_id),
            "total_minor": 369700,
            "currency": "INR",
        }

    def test_failure_cancels_and_asks_for_the_stock_back(self, db):
        order = insert_order("STOCK_RESERVED")
        assert handle_event(db, event("payment.failed", order)) == "cancelled"
        db.expire_all()
        assert db.get(Order, order.id).cancel_reason == "payment_failed"
        assert outbox_types(db) == ["order.cancelled"]

    def test_amount_mismatch_is_a_permanent_error_and_changes_nothing(self, db):
        order = insert_order("STOCK_RESERVED")
        with pytest.raises(PermanentError, match="does not match"):
            handle_event(db, event("payment.succeeded", order, amount_minor=1))
        with pytest.raises(PermanentError):
            handle_event(db, event("payment.succeeded", order, currency="USD"))
        assert status_of(db, order) == "STOCK_RESERVED"
        assert db.scalar(select(func.count()).select_from(Inbox)) == 0, (
            "a rejected event is not recorded"
        )

    def test_payment_for_a_cancelled_order_is_flagged_for_refund(self, db, caplog):
        order = insert_order("CANCELLED")
        with caplog.at_level("ERROR"):
            assert handle_event(db, event("payment.succeeded", order)) == "refund_required"
        assert "refund required" in caplog.text
        assert status_of(db, order) == "CANCELLED"

    def test_late_failure_after_paid_changes_nothing(self, db):
        order = insert_order("PAID")
        assert handle_event(db, event("payment.failed", order)) == "ignored"
        assert status_of(db, order) == "PAID"

    def test_duplicate_success_after_paid_is_ignored(self, db):
        order = insert_order("PAID")
        assert handle_event(db, event("payment.succeeded", order)) == "ignored"
        assert outbox_types(db) == []


class TestIdempotencyAndErrors:
    def test_redelivery_of_the_same_event_has_no_effect(self, db):
        order = insert_order("PENDING")
        first = event("stock.reserved", order)
        assert handle_event(db, first) == "payment_requested"
        assert handle_event(db, first) == "duplicate"
        assert outbox_types(db) == ["payment.requested"]

    def test_a_failing_handler_rolls_back_the_inbox_row_so_a_retry_can_succeed(
        self, db, monkeypatch
    ):
        order = insert_order("PENDING")
        envelope = event("stock.reserved", order)
        import app.events.handlers as handlers

        original = handlers.HANDLERS["stock.reserved"]
        monkeypatch.setitem(
            handlers.HANDLERS,
            "stock.reserved",
            lambda *a: (_ for _ in ()).throw(RuntimeError("db blip")),
        )
        with pytest.raises(RuntimeError):
            handle_event(db, envelope)
        assert db.scalar(select(func.count()).select_from(Inbox)) == 0
        monkeypatch.setitem(handlers.HANDLERS, "stock.reserved", original)
        assert handle_event(db, envelope) == "payment_requested"

    def test_unknown_order_is_permanent(self, db):
        ghost = Order(id=uuid.uuid4())
        with pytest.raises(PermanentError, match="unknown order"):
            handle_event(db, event("stock.reserved", ghost))

    def test_invalid_payload_is_permanent(self, db):
        order = insert_order()
        bad = event("stock.reserved", order)
        bad.data.pop("order_id")
        with pytest.raises(PermanentError, match="invalid stock.reserved"):
            handle_event(db, bad)

    def test_unknown_event_type_is_ignored(self, db):
        order = insert_order()
        other = event("stock.reserved", order)
        other.type = "something.else"
        assert handle_event(db, other) == "unknown_type"


class TestWholeSaga:
    def test_happy_path_then_fulfilment(self, db):
        order = insert_order("PENDING")
        handle_event(db, event("stock.reserved", order))
        handle_event(db, event("payment.succeeded", order))
        assert status_of(db, order) == "PAID"
        assert outbox_types(db) == ["payment.requested", "order.confirmed"]

    def test_payment_declined_path_compensates(self, db):
        order = insert_order("PENDING")
        handle_event(db, event("stock.reserved", order))
        handle_event(db, event("payment.failed", order))
        assert status_of(db, order) == "CANCELLED"
        assert outbox_types(db) == ["payment.requested", "order.cancelled"]
        db.expire_all()
        history = [(h.from_status, h.to_status, h.reason) for h in db.get(Order, order.id).history]
        assert history == [
            ("PENDING", "STOCK_RESERVED", None),
            ("STOCK_RESERVED", "CANCELLED", "payment_failed"),
        ]
