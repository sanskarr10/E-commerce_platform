import httpx
import pytest

from app.catalog import CatalogClient, CatalogUnavailable


def client_for(handler, retries=1):
    return CatalogClient(
        "http://product:3000/", 1.0, retries, transport=httpx.MockTransport(handler)
    )


def test_returns_products_by_id_and_sends_sorted_unique_ids():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"items": [{"id": 2, "name": "b"}, {"id": 1, "name": "a"}]})

    result = client_for(handler).get_products([2, 1, 2])
    assert set(result) == {1, 2}
    assert seen["url"] == "http://product:3000/api/products/batch?ids=1%2C2"


def test_retries_once_then_succeeds():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503) if len(calls) == 1 else httpx.Response(200, json={"items": []})

    assert client_for(handler).get_products([1]) == {}
    assert len(calls) == 2


def test_gives_up_after_the_retries():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(500)

    with pytest.raises(CatalogUnavailable):
        client_for(handler, retries=1).get_products([1])
    assert len(calls) == 2


def test_network_errors_and_garbage_are_unavailable():
    def boom(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(CatalogUnavailable):
        client_for(boom).get_products([1])
    with pytest.raises(CatalogUnavailable):
        client_for(lambda r: httpx.Response(200, json={"nope": 1})).get_products([1])


def test_client_errors_are_not_retried_into_success():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(422, json={"detail": "bad"})

    with pytest.raises(CatalogUnavailable):
        client_for(handler).get_products([1])
