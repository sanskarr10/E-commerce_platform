import asyncio
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

from prometheus_client import CollectorRegistry

from app import metrics
from app.events.consumer import PermanentError, process_delivery
from tests.support import SessionLocal, auth, fixture, insert_order

BODY = {"items": [{"product_id": 1, "quantity": 1}], "payment_method": "tok_success"}


def scrape(client) -> str:
    response = client.get("/metrics")
    assert response.status_code == 200
    return response.text


def value(text: str, name: str, labels: str = "") -> float:
    pattern = rf"^{re.escape(name)}{re.escape(labels)} ([0-9.e+-]+)$"
    match = re.search(pattern, text, re.MULTILINE)
    assert match, f"{name}{labels} not found"
    return float(match.group(1))


class TestHttpMetrics:
    def test_route_pattern_not_raw_url(self, client):
        order = insert_order("PENDING")
        client.get(f"/api/orders/{order.id}", headers=auth())
        text = scrape(client)
        assert 'route="/api/orders/{order_id}"' in text
        assert str(order.id) not in text

    def test_unknown_paths_share_one_label(self, client):
        client.get("/scanner/path/1")
        client.get("/scanner/path/2")
        text = scrape(client)
        assert 'route="unmatched"' in text
        assert "scanner" not in text

    def test_metrics_and_health_are_not_measured(self, client):
        client.get("/health")
        client.get("/metrics")
        assert 'route="/metrics"' not in scrape(client)
        assert 'route="/health"' not in scrape(client)

    def test_process_metrics_present(self, client):
        assert "process_cpu_seconds_total" in scrape(client)


class TestBusinessMetrics:
    def test_orders_created_and_replays_are_counted_separately(self, client):
        before = scrape(client)
        created0 = value(before, "orders_created_total")
        replays0 = value(before, "order_idempotent_replays_total")
        headers = {**auth(), "Idempotency-Key": f"m-{uuid.uuid4()}"}
        assert client.post("/api/orders", json=BODY, headers=headers).status_code == 201
        assert client.post("/api/orders", json=BODY, headers=headers).status_code == 200
        after = scrape(client)
        assert value(after, "orders_created_total") == created0 + 1
        assert value(after, "order_idempotent_replays_total") == replays0 + 1

    def test_orders_by_status_comes_from_the_database(self, client):
        insert_order("PAID")
        text = scrape(client)
        assert value(text, "orders_by_status", '{status="PAID"}') >= 1

    def test_oldest_unsettled_order_age_tracks_stuck_sagas(self, client):
        stuck = insert_order("PENDING")
        with SessionLocal() as db:
            order = db.get(type(stuck), stuck.id)
            order.updated_at = datetime.now(UTC) - timedelta(hours=2)
            db.commit()
        assert value(scrape(client), "orders_oldest_unsettled_age_seconds") >= 7000

    def test_outbox_backlog_is_reported(self, client):
        client.post("/api/orders", json=BODY, headers={**auth(), "Idempotency-Key": "m-outbox"})
        text = scrape(client)
        assert value(text, "outbox_unpublished_events") >= 1
        assert value(text, "outbox_oldest_unpublished_age_seconds") >= 0

    def test_a_broken_database_does_not_break_the_scrape(self):
        def broken():
            raise RuntimeError("db down")

        registry = CollectorRegistry()
        registry.register(metrics.DatabaseCollector(broken))
        from prometheus_client import generate_latest

        assert generate_latest(registry) == b""


class TestEventMetrics:
    @staticmethod
    def counter(text, event_type, outcome):
        labels = f'{{outcome="{outcome}",type="{event_type}"}}'
        try:
            return value(text, "events_consumed_total", labels)
        except AssertionError:
            return 0.0

    def run(self, handler, retries=0, body=None):
        body = body if body is not None else json.dumps(fixture("stock.reserved")).encode()
        return asyncio.run(process_delivery(body, retries, handler, 2))

    def test_outcomes_are_counted(self, client):
        base = scrape(client)

        async def ok(_envelope):
            return "paid"

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
        et = "stock.reserved"
        assert self.counter(after, et, "paid") == self.counter(base, et, "paid") + 1
        assert self.counter(after, et, "retry") == self.counter(base, et, "retry") + 1
        assert self.counter(after, et, "dead_letter") == self.counter(base, et, "dead_letter") + 2
        assert self.counter(after, "unknown", "dead_letter") == (
            self.counter(base, "unknown", "dead_letter") + 1
        )
