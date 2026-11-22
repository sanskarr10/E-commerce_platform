"""Races that only show up on a real database. Run with TEST_DATABASE_URL pointing at PostgreSQL."""

import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import func, select

from app.events.handlers import handle_event
from app.models import Inbox, Outbox, Payment
from app.provider import MockProvider
from tests.support import IS_POSTGRES, SessionLocal, requested

pytestmark = pytest.mark.skipif(not IS_POSTGRES, reason="needs PostgreSQL (set TEST_DATABASE_URL)")


def parallel(fn, n):
    with ThreadPoolExecutor(max_workers=n) as pool:
        return [f.result() for f in [pool.submit(fn, i) for i in range(n)]]


def test_concurrent_redelivery_of_one_event_charges_and_emits_once():
    provider, event = MockProvider(), requested()
    outcomes = parallel(lambda _: handle_event(SessionLocal, provider, event), 8)
    assert outcomes.count("succeeded") == 1
    assert set(outcomes) <= {"succeeded", "duplicate", "already_processed"}
    assert provider.approved_charges == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Payment)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
        assert db.scalar(select(func.count()).select_from(Inbox)) >= 1


def test_concurrent_different_events_for_one_order_charge_once():
    """Two requests for the same order (different event ids) racing on the unique order_id."""
    provider, order_id = MockProvider(), uuid.uuid4()
    outcomes = parallel(lambda _: handle_event(SessionLocal, provider, requested(order_id)), 8)
    assert outcomes.count("succeeded") == 1
    assert provider.approved_charges == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Payment)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1
