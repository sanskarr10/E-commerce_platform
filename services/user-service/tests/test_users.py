from datetime import UTC, datetime, timedelta

import jwt

from app.bootstrap import bootstrap_admin
from app.core.config import Settings
from app.core.security import create_access_token
from app.models import User
from tests.conftest import PASSWORD, auth_header, login, register, write_keypair


def token_for(client, email="user@example.com"):
    register(client, email=email)
    return login(client, email=email).json()["access_token"]


def claims_for(settings, **overrides):
    now = datetime.now(UTC)
    claims = {
        "sub": "00000000-0000-0000-0000-000000000001",
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
    }
    claims.update(overrides)
    return claims


def test_me_requires_authentication(client):
    response = client.get("/api/users/me")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_me_returns_profile_for_valid_token(client):
    token = token_for(client)
    response = client.get("/api/users/me", headers=auth_header(token))
    assert response.status_code == 200
    assert response.json()["email"] == "user@example.com"


def test_update_me_changes_full_name(client):
    token = token_for(client)
    response = client.patch(
        "/api/users/me", headers=auth_header(token), json={"full_name": "Renamed Person"}
    )
    assert response.status_code == 200
    assert client.get("/api/users/me", headers=auth_header(token)).json()["full_name"] == (
        "Renamed Person"
    )


def test_tampered_token_is_rejected(client):
    token = token_for(client)
    header, payload, signature = token.split(".")
    tampered = f"{header}.{payload}.{signature[:-4]}AAAA"
    assert client.get("/api/users/me", headers=auth_header(tampered)).status_code == 401


def test_expired_token_is_rejected(client, settings):
    past = datetime.now(UTC) - timedelta(minutes=1)
    expired = jwt.encode(
        claims_for(settings, exp=past, iat=past - timedelta(minutes=15)),
        settings.private_key,
        algorithm="RS256",
    )
    assert client.get("/api/users/me", headers=auth_header(expired)).status_code == 401


def test_token_signed_by_another_key_is_rejected(client, settings, tmp_path):
    other_private, _ = write_keypair(tmp_path, "attacker")
    forged = jwt.encode(claims_for(settings), other_private.read_text(), algorithm="RS256")
    assert client.get("/api/users/me", headers=auth_header(forged)).status_code == 401


def test_hs256_token_signed_with_the_public_key_is_rejected(client, settings):
    """Classic algorithm-confusion attack: use the public key as an HMAC secret."""
    try:
        forged = jwt.encode(claims_for(settings), settings.public_key, algorithm="HS256")
    except jwt.InvalidKeyError:
        # PyJWT refuses to even build the forged token; the verifier below pins RS256 anyway.
        return
    assert client.get("/api/users/me", headers=auth_header(forged)).status_code == 401


def test_unsigned_token_is_rejected(client, settings):
    unsigned = jwt.encode(claims_for(settings), key=None, algorithm="none")
    assert client.get("/api/users/me", headers=auth_header(unsigned)).status_code == 401


def test_token_for_wrong_audience_is_rejected(client, settings):
    wrong = jwt.encode(
        claims_for(settings, aud="some-other-app"), settings.private_key, algorithm="RS256"
    )
    assert client.get("/api/users/me", headers=auth_header(wrong)).status_code == 401


def test_token_for_deleted_or_unknown_user_is_rejected(client, settings):
    ghost = User(id="00000000-0000-0000-0000-000000000002", email="g@example.com", role="customer")
    token, _ = create_access_token(ghost, settings)
    assert client.get("/api/users/me", headers=auth_header(token)).status_code == 401


def test_deactivated_user_loses_access_immediately(client):
    from sqlalchemy import select

    from app.db import SessionLocal

    token = token_for(client)
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "user@example.com"))
        user.is_active = False
        db.commit()
    assert client.get("/api/users/me", headers=auth_header(token)).status_code == 401


def test_list_users_forbidden_for_customers(client):
    token = token_for(client)
    assert client.get("/api/users", headers=auth_header(token)).status_code == 403


def test_list_users_allowed_for_admins_with_pagination(client, make_user):
    make_user(email="boss@example.com", role="admin")
    for i in range(3):
        make_user(email=f"c{i}@example.com")
    token = login(client, email="boss@example.com").json()["access_token"]

    everyone = client.get("/api/users", headers=auth_header(token))
    assert everyone.status_code == 200
    assert len(everyone.json()) == 4

    page = client.get("/api/users?skip=1&limit=2", headers=auth_header(token))
    assert len(page.json()) == 2
    assert client.get("/api/users?limit=1000", headers=auth_header(token)).status_code == 422


def test_bootstrap_admin_is_created_once(client, settings):
    config = Settings(
        database_url=settings.database_url,
        jwt_private_key_path=settings.jwt_private_key_path,
        jwt_public_key_path=settings.jwt_public_key_path,
        admin_email="Root@Shop.dev",
        admin_password=PASSWORD,
    )
    assert bootstrap_admin(config) is True
    assert bootstrap_admin(config) is False  # second startup does nothing

    token = login(client, email="root@shop.dev").json()["access_token"]
    assert client.get("/api/users/me", headers=auth_header(token)).json()["role"] == "admin"


def test_bootstrap_admin_skipped_when_not_configured(settings):
    assert bootstrap_admin(settings) is False


def test_health_ready_and_request_id(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json() == {"status": "ready"}

    echoed = client.get("/health", headers={"X-Request-ID": "trace-123"})
    assert echoed.headers["x-request-id"] == "trace-123"
    assert client.get("/health").headers["x-request-id"]  # generated when missing


def test_openapi_is_served_under_the_gateway_prefix(client):
    assert client.get("/api/users/openapi.json").status_code == 200
    assert client.get("/api/users/docs").status_code == 200
