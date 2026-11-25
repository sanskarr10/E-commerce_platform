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
TMP = Path(tempfile.mkdtemp(prefix="order-service-tests-"))
_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = _key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()
(TMP / "jwt_public.pem").write_bytes(
    _key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
)
# SQLite by default; set TEST_DATABASE_URL to a PostgreSQL URL to run the same suite (plus the
# concurrency tests) against the production engine. The database is wiped, so use a throwaway one.
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")
os.environ.update(
    ENVIRONMENT="test",
    DATABASE_URL=TEST_DATABASE_URL or f"sqlite:///{TMP / 'test.db'}",
    JWT_PUBLIC_KEY_PATH=str(TMP / "jwt_public.pem"),
    RABBITMQ_URL="",
)

from app.db import SessionLocal, engine  # noqa: E402
from app.models import Order, OrderItem  # noqa: E402

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
        "email": "asha@example.com",
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


class FakeCatalog:
    """Stands in for the product service."""

    def __init__(self):
        self.products = {
            1: {
                "id": 1,
                "sku": "KB-1",
                "name": "Keyboard",
                "price_minor": 249900,
                "currency": "INR",
            },
            2: {"id": 2, "sku": "MS-1", "name": "Mouse", "price_minor": 59900, "currency": "INR"},
            3: {"id": 3, "sku": "US-1", "name": "Import", "price_minor": 1000, "currency": "USD"},
        }
        self.down = False
        self.calls = 0

    def get_products(self, ids):
        from app.catalog import CatalogUnavailable

        self.calls += 1
        if self.down:
            raise CatalogUnavailable("down")
        return {i: self.products[i] for i in ids if i in self.products}


def insert_order(
    status="PENDING", user_id=CUSTOMER_ID, total=369700, currency="INR", **extra
) -> Order:
    with SessionLocal() as session:
        order = Order(
            id=uuid.uuid4(),
            user_id=user_id,
            user_email="asha@example.com",
            status=status,
            total_minor=total,
            currency=currency,
            payment_method="tok_success",
            items=[
                OrderItem(
                    product_id=1, sku="KB-1", name="Keyboard", unit_price_minor=249900, quantity=1
                )
            ],
            **extra,
        )
        session.add(order)
        session.commit()
        return order
