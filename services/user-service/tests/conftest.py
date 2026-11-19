import os
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# The app reads its config at import time, so the test environment is built first:
# a throwaway SQLite file and a fresh RSA key pair in a temp directory.
TMP = Path(tempfile.mkdtemp(prefix="user-service-tests-"))


def write_keypair(directory: Path, name: str) -> tuple[Path, Path]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_path = directory / f"{name}_private.pem"
    public_path = directory / f"{name}_public.pem"
    private_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    public_path.write_bytes(
        key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    )
    return private_path, public_path


_private, _public = write_keypair(TMP, "jwt")
os.environ.update(
    ENVIRONMENT="test",
    DATABASE_URL=f"sqlite:///{TMP / 'test.db'}",
    JWT_PRIVATE_KEY_PATH=str(_private),
    JWT_PUBLIC_KEY_PATH=str(_public),
    ADMIN_EMAIL="",
    ADMIN_PASSWORD="",
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base, User  # noqa: E402

PASSWORD = "Password123"


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture
def settings():
    return get_settings()


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def make_user():
    def _make(email="user@example.com", role="customer", active=True, password=PASSWORD):
        with SessionLocal() as db:
            user = User(
                email=email,
                hashed_password=hash_password(password),
                full_name="Test User",
                role=role,
                is_active=active,
            )
            db.add(user)
            db.commit()
            return user

    return _make


def register(client, email="user@example.com", password=PASSWORD, full_name="Test User"):
    return client.post(
        "/api/users/register",
        json={"email": email, "password": password, "full_name": full_name},
    )


def login(client, email="user@example.com", password=PASSWORD):
    return client.post("/api/users/login", json={"email": email, "password": password})


def auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
