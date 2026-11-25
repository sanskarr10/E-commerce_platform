import json
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from sqlalchemy import select

from app.models import IdempotencyKey, Order, Outbox
from tests.support import (
    ADMIN,
    CUSTOMER_ID,
    OTHER_ID,
    PRIVATE_PEM,
    SessionLocal,
    auth,
    insert_order,
    make_token,
)

BODY = {
    "items": [{"product_id": 1, "quantity": 2}, {"product_id": 2, "quantity": 1}],
    "payment_method": "tok_success",
}
KEY = {"Idempotency-Key": "checkout-1"}


def place(client, body=BODY, key=KEY, headers=None):
    return client.post("/api/orders", json=body, headers={**(headers or auth()), **key})


class TestPlaceOrder:
    def test_creates_a_pending_order_with_snapshot_prices_and_total(self, client, db):
        response = place(client)
        assert response.status_code == 201
        body = response.json()
        assert body["status"] == "PENDING"
        assert body["total_minor"] == 2 * 249900 + 59900
        assert body["currency"] == "INR"
        assert body["user_id"] == str(CUSTOMER_ID)
        assert [(i["product_id"], i["quantity"], i["unit_price_minor"]) for i in body["items"]] == [
            (1, 2, 249900),
            (2, 1, 59900),
        ]
        assert "payment_method" not in body

    def test_writes_order_created_to_the_outbox_in_the_same_transaction(self, client, db):
        order_id = place(client).json()["id"]
        rows = db.execute(select(Outbox)).scalars().all()
        assert [r.event_type for r in rows] == ["order.created"]
        event = json.loads(rows[0].payload)
        assert event["correlation_id"] == order_id
        assert event["data"] == {
            "order_id": order_id,
            "items": [{"product_id": 1, "quantity": 2}, {"product_id": 2, "quantity": 1}],
        }

    def test_records_the_initial_status_in_the_history(self, client):
        order_id = place(client).json()["id"]
        detail = client.get(f"/api/orders/{order_id}", headers=auth()).json()
        assert [(h["from_status"], h["to_status"]) for h in detail["history"]] == [
            (None, "PENDING")
        ]

    def test_merges_duplicate_lines(self, client):
        body = {
            "items": [{"product_id": 1, "quantity": 1}, {"product_id": 1, "quantity": 2}],
            "payment_method": "tok_success",
        }
        order = place(client, body).json()
        assert [(i["product_id"], i["quantity"]) for i in order["items"]] == [(1, 3)]
        assert order["total_minor"] == 3 * 249900

    def test_client_supplied_prices_are_rejected(self, client):
        body = {
            "items": [{"product_id": 1, "quantity": 1, "price_minor": 1}],
            "payment_method": "tok_success",
        }
        assert place(client, body).status_code == 422

    def test_unknown_product_is_422_and_nothing_is_stored(self, client, db):
        body = {
            "items": [{"product_id": 1, "quantity": 1}, {"product_id": 99, "quantity": 1}],
            "payment_method": "t",
        }
        response = place(client, body)
        assert response.status_code == 422
        assert "99" in response.json()["detail"]
        assert db.execute(select(Order)).first() is None
        assert db.execute(select(IdempotencyKey)).first() is None

    def test_mixed_currencies_are_rejected(self, client):
        body = {
            "items": [{"product_id": 1, "quantity": 1}, {"product_id": 3, "quantity": 1}],
            "payment_method": "t",
        }
        assert "same currency" in place(client, body).json()["detail"]

    def test_catalog_outage_is_503_and_the_key_stays_usable(self, client, catalog):
        catalog.down = True
        assert place(client).status_code == 503
        catalog.down = False
        assert place(client).status_code == 201

    def test_input_validation(self, client):
        for body in (
            {"items": [], "payment_method": "t"},
            {"items": [{"product_id": 1, "quantity": 0}], "payment_method": "t"},
            {"items": [{"product_id": 0, "quantity": 1}], "payment_method": "t"},
            {"items": [{"product_id": 1, "quantity": 1}]},
            {"items": [{"product_id": 1, "quantity": 1}], "payment_method": "4111 1111 1111 1111"},
            {
                "items": [{"product_id": i, "quantity": 1} for i in range(1, 52)],
                "payment_method": "t",
            },
        ):
            assert place(client, body).status_code == 422, body

    def test_requires_authentication(self, client):
        assert client.post("/api/orders", json=BODY, headers=KEY).status_code == 401
        bad = {"Authorization": f"Bearer {make_token(exp=1)}"}
        assert client.post("/api/orders", json=BODY, headers={**bad, **KEY}).status_code == 401


class TestIdempotency:
    def test_key_is_required(self, client):
        for headers in ({}, {"Idempotency-Key": ""}, {"Idempotency-Key": "x" * 129}):
            response = client.post("/api/orders", json=BODY, headers={**auth(), **headers})
            assert response.status_code == 400, headers
            assert "Idempotency-Key" in response.json()["detail"]

    def test_retry_with_the_same_key_returns_the_original_order(self, client, db, catalog):
        first = place(client)
        second = place(client)
        assert first.status_code == 201 and second.status_code == 200
        assert second.headers["Idempotent-Replayed"] == "true"
        assert "Idempotent-Replayed" not in first.headers
        assert second.json()["id"] == first.json()["id"]
        assert len(db.execute(select(Order)).all()) == 1
        assert len(db.execute(select(Outbox)).all()) == 1, (
            "a replay must not emit a second order.created"
        )
        assert catalog.calls == 1, "a replay must not hit the catalog again"

    def test_replay_returns_the_current_status_not_the_original_one(self, client, db):
        order_id = place(client).json()["id"]
        order = db.get(Order, uuid.UUID(order_id))
        order.status = "PAID"
        db.commit()
        assert place(client).json()["status"] == "PAID"

    def test_same_key_with_a_different_body_is_rejected(self, client, db):
        place(client)
        other = {"items": [{"product_id": 1, "quantity": 5}], "payment_method": "tok_success"}
        response = place(client, other)
        assert response.status_code == 422
        assert "different request body" in response.json()["detail"]
        assert len(db.execute(select(Order)).all()) == 1

    def test_equivalent_bodies_hash_the_same_regardless_of_line_order_or_splitting(self, client):
        a = {
            "items": [{"product_id": 2, "quantity": 1}, {"product_id": 1, "quantity": 2}],
            "payment_method": "tok_success",
        }
        b = {
            "items": [
                {"product_id": 1, "quantity": 1},
                {"product_id": 1, "quantity": 1},
                {"product_id": 2, "quantity": 1},
            ],
            "payment_method": "tok_success",
        }
        first = place(client, a)
        second = place(client, b)
        assert second.status_code == 200 and second.json()["id"] == first.json()["id"]

    def test_keys_are_scoped_per_user(self, client):
        mine = place(client)
        theirs = place(client, headers=auth(OTHER_ID))
        assert theirs.status_code == 201
        assert theirs.json()["id"] != mine.json()["id"]

    def test_losing_a_race_replays_the_winner(self, client, db, monkeypatch):
        """Two requests pass the first lookup; the loser's commit hits the unique key."""
        import app.orders as orders

        winner = place(client, key={"Idempotency-Key": "race"}).json()
        real_existing = orders._existing
        calls = {"n": 0}

        def blind_first_lookup(db_, user_id, key):
            calls["n"] += 1
            return None if calls["n"] == 1 else real_existing(db_, user_id, key)

        monkeypatch.setattr(orders, "_existing", blind_first_lookup)
        loser = place(client, key={"Idempotency-Key": "race"})
        assert loser.status_code == 200
        assert loser.json()["id"] == winner["id"]
        assert len(db.execute(select(Order)).all()) == 1


class TestReading:
    def test_owner_reads_the_order_others_get_404(self, client):
        order_id = place(client).json()["id"]
        assert client.get(f"/api/orders/{order_id}", headers=auth()).status_code == 200
        assert client.get(f"/api/orders/{order_id}", headers=auth(OTHER_ID)).status_code == 404
        assert client.get(f"/api/orders/{uuid.uuid4()}", headers=auth()).status_code == 404

    def test_admin_can_read_any_order(self, client):
        order_id = place(client).json()["id"]
        assert client.get(f"/api/orders/{order_id}", headers=ADMIN).status_code == 200

    def test_list_shows_only_my_orders_newest_first_with_paging(self, client):
        ids = [place(client, key={"Idempotency-Key": f"k{i}"}).json()["id"] for i in range(3)]
        place(client, key={"Idempotency-Key": "other"}, headers=auth(OTHER_ID))
        page = client.get("/api/orders?page_size=2", headers=auth()).json()
        assert page["total"] == 3 and len(page["items"]) == 2
        rest = client.get("/api/orders?page_size=2&page=2", headers=auth()).json()
        assert {i["id"] for i in page["items"] + rest["items"]} == set(ids)
        assert client.get("/api/orders?page_size=101", headers=auth()).status_code == 422

    def test_admin_list_filters_by_status_and_is_admin_only(self, client):
        insert_order("PAID")
        insert_order("PENDING")
        assert client.get("/api/orders/admin/list", headers=auth()).status_code == 403
        assert client.get("/api/orders/admin/list").status_code == 401
        everything = client.get("/api/orders/admin/list", headers=ADMIN).json()
        assert everything["total"] == 2
        paid = client.get("/api/orders/admin/list?status=PAID", headers=ADMIN).json()
        assert [o["status"] for o in paid["items"]] == ["PAID"]
        assert client.get("/api/orders/admin/list?status=BOGUS", headers=ADMIN).status_code == 422


class TestFulfilment:
    def test_admin_ships_then_delivers_and_events_are_emitted(self, client, db):
        order = insert_order("PAID")
        shipped = client.post(f"/api/orders/{order.id}/ship", headers=ADMIN)
        assert shipped.status_code == 200 and shipped.json()["status"] == "SHIPPED"
        delivered = client.post(f"/api/orders/{order.id}/deliver", headers=ADMIN)
        assert delivered.json()["status"] == "DELIVERED"
        assert [h["to_status"] for h in delivered.json()["history"]] == ["SHIPPED", "DELIVERED"]
        assert [
            r.event_type for r in db.execute(select(Outbox).order_by(Outbox.seq)).scalars()
        ] == [
            "order.shipped",
            "order.delivered",
        ]

    def test_invalid_moves_are_409_and_emit_nothing(self, client, db):
        for status, action in (
            ("PENDING", "ship"),
            ("STOCK_RESERVED", "ship"),
            ("CANCELLED", "ship"),
            ("PAID", "deliver"),
        ):
            order = insert_order(status)
            response = client.post(f"/api/orders/{order.id}/{action}", headers=ADMIN)
            assert response.status_code == 409, (status, action)
        assert db.execute(select(Outbox)).first() is None

    def test_only_admins_can_fulfil_and_unknown_orders_are_404(self, client):
        order = insert_order("PAID")
        assert client.post(f"/api/orders/{order.id}/ship", headers=auth()).status_code == 403
        assert client.post(f"/api/orders/{uuid.uuid4()}/ship", headers=ADMIN).status_code == 404


class TestPlatform:
    def test_health_ready_and_docs(self, client):
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/ready").json() == {"status": "ready", "messaging": "disabled"}
        assert client.get("/api/orders/openapi.json").status_code == 200
        assert client.get("/api/orders/docs").status_code == 200

    def test_request_id_is_propagated(self, client):
        response = client.get("/health", headers={"X-Request-ID": "abc123"})
        assert response.headers["X-Request-ID"] == "abc123"


class TestCustomerEmailSnapshot:
    BODY = {"items": [{"product_id": 1, "quantity": 1}], "payment_method": "tok_success"}

    def test_email_from_the_token_is_stored_and_sent_in_events(self, client, db):
        placed = client.post(
            "/api/orders", json=self.BODY, headers={**auth(), "Idempotency-Key": "e1"}
        )
        assert placed.status_code == 201
        assert "user_email" not in placed.json()  # contact data is not echoed back
        order_id = uuid.UUID(placed.json()["id"])
        with SessionLocal() as s:
            order = s.get(Order, order_id)
            assert order.user_email == "asha@example.com"
            order.status = "PAID"
            s.commit()
        client.post(f"/api/orders/{order_id}/ship", headers=ADMIN)
        shipped = [
            json.loads(r.payload)
            for r in db.execute(select(Outbox)).scalars()
            if r.event_type == "order.shipped"
        ]
        assert shipped[0]["data"]["user_email"] == "asha@example.com"

    def test_token_without_email_still_places_the_order(self, client, db):
        bare = jwt.encode(
            {
                "sub": str(CUSTOMER_ID),
                "role": "customer",
                "iss": "ecommerce-user-service",
                "aud": "ecommerce",
                "iat": datetime.now(UTC),
                "exp": datetime.now(UTC) + timedelta(minutes=5),
            },
            PRIVATE_PEM,
            algorithm="RS256",
        )
        r = client.post(
            "/api/orders",
            json=self.BODY,
            headers={"Authorization": f"Bearer {bare}", "Idempotency-Key": "e2"},
        )
        assert r.status_code == 201
        with SessionLocal() as s:
            assert s.get(Order, uuid.UUID(r.json()["id"])).user_email is None
