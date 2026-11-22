import json
import os
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# The app reads its config at import time, so the test environment is built first.
TMP = Path(tempfile.mkdtemp(prefix="payment-service-tests-"))
_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = _key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()
(TMP / "jwt_public.pem").write_bytes(
    _key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
)
# SQLite by default; set TEST_DATABASE_URL to PostgreSQL to run the same suite plus the races.
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")
os.environ.update(
    ENVIRONMENT="test",
    DATABASE_URL=TEST_DATABASE_URL or f"sqlite:///{TMP / 'test.db'}",
    JWT_PUBLIC_KEY_PATH=str(TMP / "jwt_public.pem"),
    RABBITMQ_URL="",
)

from app.db import SessionLocal, engine  # noqa: E402
from app.events.schemas import Envelope  # noqa: E402
from app.models import Payment  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "docs" / "events" / "fixtures"
IS_POSTGRES = engine.dialect.name == "postgresql"
CUSTOMER_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
OTHER_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
ADMIN_ID = uuid.UUID("99999999-9999-4999-8999-999999999999")


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def make_token(sub=CUSTOMER_ID, role="customer", **overrides) -> str:
    now = datetime.now(UTC)
    claims = {
        "sub": str(sub),
        "role": role,
        "iss": "ecommerce-user-service",
        "aud": "ecommerce",
        "iat": now,
        "exp": now + timedelta(minutes=5),
        **overrides,
    }
    return jwt.encode(claims, PRIVATE_PEM, algorithm="RS256")


def auth(sub=CUSTOMER_ID, role="customer") -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub, role)}"}


ADMIN = {"Authorization": f"Bearer {make_token(ADMIN_ID, 'admin')}"}


def requested(order_id=None, method="tok_success", event_id=None, **data) -> Envelope:
    """A payment.requested envelope shaped like the shared fixture."""
    raw = fixture("payment.requested")
    order_id = order_id or uuid.uuid4()
    raw["id"] = str(event_id or uuid.uuid4())
    raw["correlation_id"] = str(order_id)
    raw["data"] = {
        **raw["data"],
        "order_id": str(order_id),
        "payment_method": method,
        **data,
    }
    return Envelope.model_validate(raw)


def insert_payment(status="SUCCEEDED", user_id=CUSTOMER_ID, order_id=None) -> Payment:
    with SessionLocal() as db:
        payment = Payment(
            id=uuid.uuid4(),
            order_id=order_id or uuid.uuid4(),
            user_id=user_id,
            amount_minor=249900,
            currency="INR",
            payment_method="tok_success",
            status=status,
        )
        db.add(payment)
        db.commit()
        return payment
