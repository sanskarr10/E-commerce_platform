import asyncio
import json
import uuid

import pytest
from sqlalchemy import select

from app.events.bus import RabbitBus, declare_topology
from app.events.consumer import PermanentError, process_delivery
from app.events.envelope import CONSUMED_TYPES, EXCHANGE, QUEUE, build_envelope
from app.events.handlers import handle_event
from app.events.relay import OutboxRelay, OutboxStore
from app.events.schemas import PAYLOADS, Envelope
from app.models import Outbox
from tests.support import ADMIN, FIXTURES, SessionLocal, auth, fixture, insert_order


def shape(value):
    """Keys and value types only, so fixtures pin the contract without pinning the values."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__


class TestContract:
    def test_every_consumed_event_fixture_parses(self):
        for kind, model in PAYLOADS.items():
            raw = fixture(kind)
            Envelope.model_validate(raw)
            model.model_validate(raw["data"])
        assert set(PAYLOADS) == set(CONSUMED_TYPES)

    def test_unknown_fields_are_tolerated(self):
        raw = fixture("stock.reserved")
        raw["data"]["added_later"] = 1
        raw["added_too"] = True
        PAYLOADS["stock.reserved"].model_validate(raw["data"])
        Envelope.model_validate(raw)

    def test_every_event_this_service_produces_matches_its_fixture(self, client, db):
        """Runs the real code paths and compares what lands in the outbox with the shared fixtures."""
        body = {"items": [{"product_id": 1, "quantity": 2}], "payment_method": "tok_success"}
        placed = client.post("/api/orders", json=body, headers={**auth(), "Idempotency-Key": "c"})
        order = insert_order("PAID")
        client.post(f"/api/orders/{order.id}/ship", headers=ADMIN)
        client.post(f"/api/orders/{order.id}/deliver", headers=ADMIN)
        pending = insert_order("PENDING")
        reserved = Envelope.model_validate({**fixture("stock.reserved"), "id": str(uuid.uuid4())})
        reserved.data["order_id"] = str(pending.id)
        handle_event(db, reserved)  # payment.requested
        paid = insert_order("STOCK_RESERVED")
        ok = fixture("payment.succeeded")
        ok.update(id=str(uuid.uuid4()))
        ok["data"].update(order_id=str(paid.id), amount_minor=paid.total_minor)
        handle_event(db, Envelope.model_validate(ok))  # order.confirmed
        failed = insert_order("STOCK_RESERVED")
        bad = fixture("payment.failed")
        bad.update(id=str(uuid.uuid4()))
        bad["data"].update(order_id=str(failed.id))
        handle_event(db, Envelope.model_validate(bad))  # order.cancelled
        assert placed.status_code == 201

        seen = {}
        for row in db.execute(select(Outbox)).scalars():
            seen.setdefault(row.event_type, json.loads(row.payload))
        assert set(seen) == {
            "order.created",
            "payment.requested",
            "order.confirmed",
            "order.cancelled",
            "order.shipped",
            "order.delivered",
        }
        for kind, envelope in seen.items():
            expected = fixture(kind)
            assert shape(envelope) == shape(expected), kind
            assert envelope["type"] == kind and envelope["version"] == 1
            Envelope.model_validate(envelope)

    def test_fixture_set_is_complete(self):
        assert len(list(FIXTURES.glob("*.json"))) == 10

    def test_build_envelope_is_unique_and_correlated(self):
        a, b = build_envelope("x.y", {}, "corr"), build_envelope("x.y", {}, "corr")
        assert a["id"] != b["id"] and a["correlation_id"] == "corr"
        assert a["occurred_at"].endswith("Z")


class TestProcessDelivery:
    @staticmethod
    def run(body, handle, retries=0, maximum=3):
        return asyncio.run(process_delivery(body, retries, handle, maximum))

    @staticmethod
    async def ok(_envelope):
        return None

    def body(self, kind="stock.reserved"):
        return json.dumps(fixture(kind)).encode()

    def test_ack(self):
        assert self.run(self.body(), self.ok).action == "ack"

    def test_malformed_bodies_go_to_the_dlq(self):
        for body in (b"{nope", b'{"hello": 1}', b"[]", b""):
            decision = self.run(body, self.ok)
            assert (decision.action, decision.reason) == ("dead_letter", "malformed_envelope")

    def test_permanent_errors_are_not_retried(self):
        async def boom(_):
            raise PermanentError("never")

        decision = self.run(self.body(), boom)
        assert (decision.action, decision.reason) == ("dead_letter", "permanent_error")

    def test_transient_errors_retry_with_a_counter_then_dead_letter(self):
        async def boom(_):
            raise RuntimeError("db down")

        first = self.run(self.body(), boom)
        assert (first.action, first.attempt) == ("retry", 1)
        assert self.run(self.body(), boom, retries=2).attempt == 3
        last = self.run(self.body(), boom, retries=3)
        assert (last.action, last.reason) == ("dead_letter", "retries_exhausted")


class FakeStore:
    def __init__(self, n):
        self.rows = [(i, f"id-{i}", f"type.{i}", f"{{{i}}}") for i in range(1, n + 1)]
        self.published, self.released = [], []

    def claim(self):
        return list(self.rows)

    def mark_published(self, seqs):
        self.published += seqs

    def release(self, seqs):
        self.released += seqs


class TestRelay:
    def test_publishes_in_order_and_marks_everything(self):
        sent = []

        async def publish(key, body, message_id):
            sent.append((key, message_id))

        relay = OutboxRelay(FakeStore(3), publish)
        assert asyncio.run(relay.flush()) == 3
        assert sent == [("type.1", "id-1"), ("type.2", "id-2"), ("type.3", "id-3")]
        assert relay.store.published == [1, 2, 3] and relay.store.released == []

    def test_stops_at_the_first_failure_and_releases_the_rest_in_order(self):
        async def publish(key, body, message_id):
            if key == "type.2":
                raise ConnectionError("nack")

        relay = OutboxRelay(FakeStore(4), publish)
        assert asyncio.run(relay.flush()) == 1
        assert relay.store.published == [1]
        assert relay.store.released == [2, 3, 4]

    def test_run_survives_a_failing_pass_and_can_be_cancelled(self):
        calls = {"n": 0}

        class Flaky(FakeStore):
            def claim(self):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise RuntimeError("db blip")
                return []

        async def scenario():
            relay = OutboxRelay(Flaky(0), None, interval=0.01)
            task = asyncio.create_task(relay.run())
            await asyncio.sleep(0.15)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())
        assert calls["n"] >= 2


class TestOutboxStore:
    def add(self, n):
        with SessionLocal() as db:
            for i in range(n):
                db.add(Outbox(id=uuid.uuid4(), event_type=f"t.{i}", payload="{}"))
            db.commit()

    def test_claim_leases_in_order_and_release_and_publish_work(self):
        self.add(4)
        store = OutboxStore(SessionLocal)
        first = store.claim(limit=2)
        assert [r[2] for r in first] == ["t.0", "t.1"]
        assert [r[2] for r in store.claim()] == ["t.2", "t.3"], "leased rows are skipped"
        assert store.claim() == []
        store.release([r[0] for r in first])
        assert [r[2] for r in store.claim()] == ["t.0", "t.1"]
        store.mark_published([r[0] for r in first])
        store.release([r[0] for r in first])  # releasing a published row must not resurrect it
        assert store.claim() == []
        store.mark_published([])
        store.release([])

    def test_an_expired_lease_makes_the_row_claimable_again(self):
        from datetime import timedelta

        from app.models import utcnow

        self.add(1)
        store = OutboxStore(SessionLocal)
        assert len(store.claim()) == 1
        with SessionLocal() as db:
            row = db.execute(select(Outbox)).scalar_one()
            row.claimed_until = utcnow() - timedelta(seconds=1)
            db.commit()
        assert len(store.claim()) == 1, "a crashed relay's rows are picked up after the lease"


class FakeChannel:
    def __init__(self):
        self.exchanges, self.queues, self.bindings, self.sent = [], {}, [], []
        self.default_exchange = self

    async def declare_exchange(self, name, kind, durable):
        self.exchanges.append((name, str(kind), durable))
        return "exchange"

    async def declare_queue(self, name, durable, arguments=None):
        self.queues[name] = arguments
        outer = self

        class Queue:
            async def bind(self, exchange, routing_key):
                outer.bindings.append((name, routing_key))

        return Queue()

    async def publish(self, message, routing_key):
        self.sent.append((routing_key, message))


class FakeMessage:
    def __init__(self, body, headers=None):
        self.body, self.headers = body, headers or {}
        self.acked = self.nacked = False
        self.requeue = None

    async def ack(self):
        self.acked = True

    async def nack(self, requeue):
        self.nacked, self.requeue = True, requeue


class TestBus:
    def test_topology(self):
        channel = FakeChannel()
        asyncio.run(declare_topology(channel, 1234))
        assert channel.exchanges[0][0] == EXCHANGE and channel.exchanges[0][2] is True
        assert list(channel.queues) == [QUEUE, f"{QUEUE}.retry", f"{QUEUE}.dlq"]
        assert channel.queues[f"{QUEUE}.retry"] == {
            "x-message-ttl": 1234,
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": QUEUE,
        }
        assert sorted(k for _, k in channel.bindings) == sorted(CONSUMED_TYPES)

    def bus(self, handle, max_retries=2):
        bus = RabbitBus("amqp://x", handle, max_retries=max_retries, retry_delay_ms=10, prefetch=1)
        bus.channel = FakeChannel()
        return bus

    def deliver(self, bus, message):
        asyncio.run(bus._on_message(message))

    def test_handled_message_is_acked(self):
        async def ok(_):
            return None

        bus, message = self.bus(ok), FakeMessage(json.dumps(fixture("stock.reserved")).encode())
        self.deliver(bus, message)
        assert message.acked and bus.channel.sent == []

    def test_transient_failure_goes_to_retry_with_counter_then_is_acked(self):
        async def boom(_):
            raise RuntimeError("x")

        bus = self.bus(boom)
        message = FakeMessage(json.dumps(fixture("stock.reserved")).encode(), {"x-retries": 1})
        self.deliver(bus, message)
        queue, sent = bus.channel.sent[0]
        assert queue == f"{QUEUE}.retry" and sent.headers["x-retries"] == 2
        assert message.acked

    def test_poison_message_goes_to_the_dlq_with_a_reason(self):
        bus, message = self.bus(None), FakeMessage(b"garbage")
        self.deliver(bus, message)
        queue, sent = bus.channel.sent[0]
        assert queue == f"{QUEUE}.dlq"
        assert sent.headers["x-dead-letter-reason"] == "malformed_envelope"
        assert message.acked

    def test_if_the_message_cannot_be_settled_it_is_requeued_not_lost(self):
        async def boom(_):
            raise RuntimeError("x")

        bus = self.bus(boom)

        async def refuse(*_a, **_k):
            raise ConnectionError("channel closed")

        bus.channel.default_exchange.publish = refuse
        message = FakeMessage(json.dumps(fixture("stock.reserved")).encode())
        self.deliver(bus, message)
        assert message.nacked and message.requeue is True and not message.acked

    def test_publish_uses_persistent_messages_with_the_event_id(self):
        class Exchange:
            async def publish(self, message, routing_key):
                self.last = (message, routing_key)

        bus = self.bus(None)
        bus.exchange = Exchange()
        asyncio.run(bus.publish("order.created", '{"a":1}', "evt-1"))
        message, key = bus.exchange.last
        assert key == "order.created" and message.message_id == "evt-1"
        assert message.delivery_mode == 2 and message.body == b'{"a":1}'
