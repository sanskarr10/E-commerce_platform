import re

from tests.conftest import login, register


def scrape(client) -> str:
    response = client.get("/metrics")
    assert response.status_code == 200
    return response.text


def value(text: str, name: str, labels: str = "") -> float:
    match = re.search(rf"^{re.escape(name)}{re.escape(labels)} ([0-9.e+-]+)$", text, re.MULTILINE)
    return float(match.group(1)) if match else 0.0


def test_metrics_endpoint_is_prometheus_text(client):
    response = client.get("/metrics")
    assert response.headers["content-type"].startswith("text/plain")
    assert "# TYPE http_request_duration_seconds histogram" in response.text
    assert "process_cpu_seconds_total" in response.text


def test_route_pattern_not_raw_url_and_unknown_paths_share_a_label(client):
    client.get("/scanner/a/123")
    client.get("/scanner/b/456")
    text = scrape(client)
    assert 'route="unmatched"' in text
    assert "scanner" not in text


def test_metrics_and_health_are_not_measured(client):
    client.get("/health")
    before = scrape(client)
    client.get("/metrics")
    client.get("/health")
    after = scrape(client)
    assert 'route="/metrics"' not in after and 'route="/health"' not in after
    assert before.count("http_request_duration_seconds_count") == after.count(
        "http_request_duration_seconds_count"
    )


def test_registrations_and_logins_are_counted(client):
    base = scrape(client)
    register(client, email="m1@example.com")
    login(client, email="m1@example.com")
    login(client, email="m1@example.com", password="WrongPassword1")
    text = scrape(client)
    assert value(text, "user_registrations_total") == value(base, "user_registrations_total") + 1
    for result in ("success", "failure"):
        label = f'{{result="{result}"}}'
        assert (
            value(text, "user_logins_total", label) == value(base, "user_logins_total", label) + 1
        )


def test_a_failed_registration_is_not_counted(client):
    register(client, email="m2@example.com")
    base = scrape(client)
    assert register(client, email="m2@example.com").status_code == 409
    assert value(scrape(client), "user_registrations_total") == value(
        base, "user_registrations_total"
    )


def test_refresh_results_including_replay(client):
    register(client, email="m3@example.com")
    login(client, email="m3@example.com")
    old_cookie = client.cookies.get("refresh_token")
    base = scrape(client)

    assert client.post("/api/users/refresh").status_code == 200  # success, rotates the cookie
    client.cookies.set("refresh_token", old_cookie, path="/api/users")
    assert client.post("/api/users/refresh").status_code == 401  # the used token comes back: replay
    client.cookies.clear()
    assert client.post("/api/users/refresh").status_code == 401  # missing
    client.cookies.set("refresh_token", "garbage", path="/api/users")
    assert client.post("/api/users/refresh").status_code == 401  # invalid

    text = scrape(client)
    for result in ("success", "replay", "missing", "invalid"):
        label = f'{{result="{result}"}}'
        assert (
            value(text, "user_token_refreshes_total", label)
            == value(base, "user_token_refreshes_total", label) + 1
        ), result


def test_no_personal_data_in_labels(client):
    register(client, email="secret.person@example.com")
    login(client, email="secret.person@example.com")
    assert "secret.person" not in scrape(client)
