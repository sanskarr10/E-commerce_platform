# isort: off
from tests.support import SessionLocal  # noqa: I001  (configures the test environment: first)

import pytest
from fastapi.testclient import TestClient

from app.db import engine
from app.main import app
from app.models import Base
from app.provider import MockProvider

# isort: on


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def provider():
    return MockProvider()


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session
