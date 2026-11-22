"""Races that only show up on a real database. Run with TEST_DATABASE_URL pointing at PostgreSQL."""

import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.events.handlers import handle_event
from app.events.relay import OutboxStore
from app.events.schemas import Envelope
from app.main import app
from app.models import Inbox, Order, Outbox
from tests.support import IS_POSTGRES, SessionLocal, auth, fixture, insert_order

pytestmark = pytest.mark.skipif(not IS_POSTGRES, reason="needs PostgreSQL (set TEST_DATABASE_URL)")

BODY = {"items": [{"product_id": 1, "quantity": 1}], "payment_method": "tok_success"}


def envelope(kind, order, event_id=None, **data) -> Envelope:
    raw = fixture(kind)
    raw["id"] = event_id or str(uuid.uuid4())
    raw["data"] = {**raw["data"], "order_id": str(order.id), **data}
    return Envelope.model_validate(raw)


def parallel(fn, n):
    with ThreadPoolExecutor(max_workers=n) as pool:
        return [f.result() for f in [pool.submit(fn, i) for i in range(n)]]


def test_concurrent_posts_with_one_idempotency_key_create_exactly_one_order(catalog):
    def post(_):
        response = TestClient(app).post(
            "/api/orders", json=BODY, headers={**auth(), "Idempotency-Key": "same-key"}
        )
        return response.status_code, response.json().get("id")

    results = parallel(post, 12)
    assert {status for status, _ in results} <= {200, 201}
    assert sum(1 for status, _ in results if status == 201) == 1
    assert len({order_id for _, order_id in results}) == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Order)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_concurrent_redelivery_of_one_event_applies_it_once():
    order = insert_order("PENDING")
    event = envelope("stock.reserved", order)

    def deliver(_):
        with SessionLocal() as db:
            return handle_event(db, event)

    outcomes = parallel(deliver, 8)
    assert outcomes.count("payment_requested") == 1
    assert set(outcomes) <= {"payment_requested", "duplicate"}
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.scalar(select(func.count()).select_from(Inbox)) == 1


def test_conflicting_events_for_one_order_leave_a_consistent_state():
    """stock.failed racing stock.reserved: whichever takes the row lock first decides the order.

    Reserved first: the order moves on and the failure is ignored.
    Failed first: the order is cancelled and the late reservation triggers a re-sent cancellation
    so the product service gives the stock back.
    """
    order = insert_order("PENDING")
    events = [envelope("stock.reserved", order), envelope("stock.failed", order)]

    def deliver(i):
        with SessionLocal() as db:
            return handle_event(db, events[i])

    outcomes = parallel(deliver, 2)
    assert sorted(outcomes) in (
        ["cancelled", "re_emitted_cancel"],
        ["ignored", "payment_requested"],
    )
    with SessionLocal() as db:
        final = db.get(Order, order.id)
        assert final.status in {"CANCELLED", "STOCK_RESERVED"}
        assert len(final.history) == 1, "exactly one transition was applied"
        types = [r.event_type for r in db.execute(select(Outbox)).scalars()]
        assert types in (["order.cancelled", "order.cancelled"], ["payment.requested"])


def test_concurrent_relays_never_claim_the_same_row():
    with SessionLocal() as db:
        for i in range(40):
            db.add(Outbox(id=uuid.uuid4(), event_type=f"t.{i}", payload="{}"))
        db.commit()
    store = OutboxStore(SessionLocal)
    claimed = parallel(lambda _: [row[0] for row in store.claim(limit=10)], 6)
    flat = [seq for batch in claimed for seq in batch]
    assert len(flat) == len(set(flat)) == 40
    assert all(batch == sorted(batch) for batch in claimed), "each relay sees its rows in order"
