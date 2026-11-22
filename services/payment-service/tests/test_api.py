import uuid

from tests.support import ADMIN, OTHER_ID, auth, insert_payment, make_token


def test_owner_reads_the_payment_for_an_order(client):
    payment = insert_payment("SUCCEEDED")
    response = client.get(f"/api/payments/orders/{payment.order_id}", headers=auth())
    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["amount_minor"], body["currency"]) == ("SUCCEEDED", 249900, "INR")
    assert body["order_id"] == str(payment.order_id)
    assert "payment_method" not in body, "the token is never exposed"


def test_other_users_and_unknown_orders_get_404_and_admin_can_read(client):
    payment = insert_payment()
    url = f"/api/payments/orders/{payment.order_id}"
    assert client.get(url, headers=auth(OTHER_ID)).status_code == 404
    assert client.get(f"/api/payments/orders/{uuid.uuid4()}", headers=auth()).status_code == 404
    assert client.get(url, headers=ADMIN).status_code == 200


def test_authentication_is_required_and_validated(client):
    url = f"/api/payments/orders/{uuid.uuid4()}"
    assert client.get(url).status_code == 401
    assert (
        client.get(url, headers={"Authorization": f"Bearer {make_token(exp=1)}"}).status_code == 401
    )
    assert client.get("/api/payments/orders/not-a-uuid", headers=auth()).status_code == 422


def test_there_is_no_way_to_create_a_payment_over_http(client):
    for method in ("post", "put", "patch", "delete"):
        response = getattr(client, method)("/api/payments", headers=ADMIN)
        assert response.status_code in (404, 405), method


def test_admin_list_filters_pages_and_requires_admin(client):
    insert_payment("SUCCEEDED")
    insert_payment("FAILED")
    insert_payment("FAILED")
    assert client.get("/api/payments/admin/list", headers=auth()).status_code == 403
    assert client.get("/api/payments/admin/list").status_code == 401
    assert client.get("/api/payments/admin/list", headers=ADMIN).json()["total"] == 3
    failed = client.get("/api/payments/admin/list?status=FAILED&page_size=1", headers=ADMIN).json()
    assert (failed["total"], len(failed["items"])) == (2, 1)
    assert client.get("/api/payments/admin/list?status=NOPE", headers=ADMIN).status_code == 422
    assert client.get("/api/payments/admin/list?page_size=101", headers=ADMIN).status_code == 422


def test_health_ready_docs_and_request_id(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json() == {"status": "ready", "messaging": "disabled"}
    assert client.get("/api/payments/openapi.json").status_code == 200
    assert client.get("/api/payments/docs").status_code == 200
    assert client.get("/health", headers={"X-Request-ID": "abc"}).headers["X-Request-ID"] == "abc"
