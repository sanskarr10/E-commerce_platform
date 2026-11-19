import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import Settings

ALGORITHM = "RS256"

_hasher = PasswordHasher()
# Verified against when the email is unknown, so "no such user" and "wrong password"
# take the same time and cannot be told apart by timing.
DUMMY_HASH = _hasher.hash("dummy-password-for-constant-time-login")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(user, settings: Settings) -> tuple[str, int]:
    now = datetime.now(UTC)
    ttl = timedelta(minutes=settings.access_token_ttl_minutes)
    claims = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "iat": now,
        "exp": now + ttl,
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, settings.private_key, algorithm=ALGORITHM), int(ttl.total_seconds())


def decode_access_token(token: str, settings: Settings) -> dict:
    """Raises jwt.PyJWTError on any problem. The algorithm is pinned to RS256."""
    return jwt.decode(
        token,
        settings.public_key,
        algorithms=[ALGORITHM],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
        options={"require": ["exp", "iat", "sub"]},
    )


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    """Only the hash is stored, so a database leak does not leak usable sessions."""
    return hashlib.sha256(token.encode()).hexdigest()
