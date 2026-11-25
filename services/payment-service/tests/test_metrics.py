import asyncio
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from prometheus_client import CollectorRegistry, generate_latest

from app import metrics
from app.events.consumer import PermanentError, process_delivery
from app.events.handlers import handle_event
from app.models import Payment
from app.provider import ProviderUnavailable
from tests.support import SessionLocal, auth, fixture, requested


def scrape(client) -> str:
    response = client.get("/metrics")
    assert response.status_code == 200
    return response.text


def value(text: str, name: str, labels: str = "") -> float:
    match = re.search(rf"^{re.escape(name)}{re.escape(labels)} ([0-9.e+-]+)$", text, re.MULTILINE)
    return float(match.group(1)) if match else 0.0


def provider_calls(text, result):
    return value(text, "payment_provider_calls_total", f'{{result="{result}"}}')


class TestHttpMetrics:
    def test_route_pattern_not_raw_url(self, client):
        order_id = uuid.uuid4()
        client.get(f"/api/payments/orders/{order_id}", headers=auth())
        text = scrape(client)
        assert 'route="/api/payments/orders/{order_id}"' in text
        assert str(order_id) not in text

    def test_unknown_paths_share_one_label(self, client):
        client.get("/scanner/a/1")
        client.get("/scanner/b/2")
        text = scrape(client)
        assert 'route="unmatched"' in text
        assert "scanner" not in text

    def test_metrics_and_health_are_not_measured(self, client):
        client.get("/health")
        client.get("/metrics")
        text = scrape(client)
        assert 'route="/metrics"' not in text
        assert 'route="/health"' not in text


class TestProviderMetrics:
    def test_success_decline_and_outage_are_counted(self, client, provider):
        base = scrape(client)
        handle_event(SessionLocal, provider, requested(uuid.uuid4()))  # tok_success
        handle_event(SessionLocal, provider, requested(uuid.uuid4(), payment_method="tok_decline"))
        with pytest.raises(ProviderUnavailable):
            handle_event(
                SessionLocal, provider, requested(uuid.uuid4(), payment_method="tok_error")
            )
        after = scrape(client)
        for result in ("succeeded", "declined", "unavailable"):
            assert provider_calls(after, result) == provider_calls(base, result) + 1, result
        assert value(after, "payment_provider_duration_seconds_count") == (
            value(base, "payment_provider_duration_seconds_count") + 3
        )

    def test_a_duplicate_event_does_not_call_the_provider_again(self, client, provider):
        envelope = requested(uuid.uuid4())
        handle_event(SessionLocal, provider, envelope)
        before = provider_calls(scrape(client), "succeeded")
        assert handle_event(SessionLocal, provider, envelope) == "duplicate"
        assert provider_calls(scrape(client), "succeeded") == before


class TestDatabaseGauges:
    def test_payments_by_status_and_outbox_backlog(self, client, provider):
        handle_event(SessionLocal, provider, requested(uuid.uuid4()))
        text = scrape(client)
        assert value(text, "payments_by_status", '{status="SUCCEEDED"}') >= 1
        assert value(text, "outbox_unpublished_events") >= 1
        assert value(text, "outbox_oldest_unpublished_age_seconds") >= 0

    def test_oldest_pending_payment_age(self, client):
        with SessionLocal() as db:
            db.add(
                Payment(
                    id=uuid.uuid4(),
                    order_id=uuid.uuid4(),
                    user_id=uuid.uuid4(),
                    amount_minor=100,
                    currency="INR",
                    payment_method="tok_success",
                    status="PENDING",
                    created_at=datetime.now(UTC) - timedelta(minutes=30),
                )
            )
            db.commit()
        assert value(scrape(client), "payments_oldest_pending_age_seconds") >= 1700

    def test_a_broken_database_does_not_break_the_scrape(self):
        def broken():
            raise RuntimeError("db down")

        registry = CollectorRegistry()
        registry.register(metrics.DatabaseCollector(broken))
        assert generate_latest(registry) == b""


class TestEventMetrics:
    @staticmethod
    def counter(text, event_type, outcome):
        return value(text, "events_consumed_total", f'{{outcome="{outcome}",type="{event_type}"}}')

    @staticmethod
    def run(handler, retries=0, body=None):
        body = body if body is not None else json.dumps(fixture("payment.requested")).encode()
        return asyncio.run(process_delivery(body, retries, handler, 2))

    def test_outcomes_are_counted(self, client):
        base = scrape(client)

        async def ok(_envelope):
            return "succeeded"

        async def boom(_envelope):
            raise RuntimeError("x")

        async def permanent(_envelope):
            raise PermanentError("bad")

        self.run(ok)
        self.run(boom)
        self.run(boom, retries=2)
        self.run(permanent)
        self.run(ok, body=b"{nope")
        after = scrape(client)
        et = "payment.requested"
        assert self.counter(after, et, "succeeded") == self.counter(base, et, "succeeded") + 1
        assert self.counter(after, et, "retry") == self.counter(base, et, "retry") + 1
        assert self.counter(after, et, "dead_letter") == self.counter(base, et, "dead_letter") + 2
        assert self.counter(after, "unknown", "dead_letter") == (
            self.counter(base, "unknown", "dead_letter") + 1
        )
