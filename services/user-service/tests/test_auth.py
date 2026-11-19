from tests.conftest import PASSWORD, login, register


def test_register_creates_customer_without_leaking_password(client):
    response = register(client, email="New.User@Example.com")
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "new.user@example.com"  # normalised to lower case
    assert body["role"] == "customer"
    assert "password" not in body and "hashed_password" not in body


def test_register_duplicate_email_is_conflict_case_insensitive(client):
    assert register(client, email="dup@example.com").status_code == 201
    assert register(client, email="DUP@example.com").status_code == 409


def test_register_cannot_choose_a_role(client):
    response = client.post(
        "/api/users/register",
        json={"email": "evil@example.com", "password": PASSWORD, "full_name": "X", "role": "admin"},
    )
    assert response.status_code == 201
    assert response.json()["role"] == "customer"


def test_register_rejects_weak_passwords_and_bad_email(client):
    assert register(client, password="short1").status_code == 422
    assert register(client, password="onlyletters").status_code == 422
    assert register(client, password="12345678").status_code == 422
    assert register(client, email="not-an-email").status_code == 422


def test_login_returns_token_and_httponly_refresh_cookie(client):
    register(client)
    response = login(client)
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 15 * 60
    cookie = response.headers["set-cookie"].lower()
    assert "refresh_token=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "path=/api/users" in cookie


def test_login_failures_are_indistinguishable(client):
    register(client)
    wrong_password = login(client, password="WrongPassword1")
    unknown_email = login(client, email="nobody@example.com")
    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json()


def test_inactive_user_cannot_login(client, make_user):
    make_user(email="off@example.com", active=False)
    assert login(client, email="off@example.com").status_code == 401


def test_refresh_rotates_token(client):
    register(client)
    login(client)
    first = client.cookies.get("refresh_token")

    response = client.post("/api/users/refresh")
    assert response.status_code == 200
    assert response.json()["access_token"]
    second = client.cookies.get("refresh_token")
    assert second and second != first


def test_replaying_a_used_refresh_token_revokes_the_whole_session_family(client):
    register(client)
    login(client)
    stolen = client.cookies.get("refresh_token")

    assert client.post("/api/users/refresh").status_code == 200  # legitimate rotation
    newest = client.cookies.get("refresh_token")

    # The attacker replays the old, already-used token...
    replay = client.post("/api/users/refresh", headers={"Cookie": f"refresh_token={stolen}"})
    assert replay.status_code == 401
    # ...which also kills the victim's newest token.
    legit = client.post("/api/users/refresh", headers={"Cookie": f"refresh_token={newest}"})
    assert legit.status_code == 401


def test_refresh_without_cookie_is_rejected(client):
    assert client.post("/api/users/refresh").status_code == 401


def test_refresh_with_garbage_cookie_is_rejected(client):
    response = client.post("/api/users/refresh", headers={"Cookie": "refresh_token=garbage"})
    assert response.status_code == 401


def test_logout_revokes_refresh_token(client):
    register(client)
    login(client)
    token = client.cookies.get("refresh_token")

    assert client.post("/api/users/logout").status_code == 204
    after = client.post("/api/users/refresh", headers={"Cookie": f"refresh_token={token}"})
    assert after.status_code == 401


def test_logout_without_session_is_still_204(client):
    assert client.post("/api/users/logout").status_code == 204
