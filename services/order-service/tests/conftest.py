# isort: off
from tests.support import FakeCatalog  # noqa: I001  (configures the test environment: first)

import pytest
from fastapi.testclient import TestClient

from app.catalog import get_catalog
from app.db import SessionLocal, engine
from app.main import app
from app.models import Base

# isort: on


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture
def catalog():
    fake = FakeCatalog()
    app.dependency_overrides[get_catalog] = lambda: fake
    yield fake
    app.dependency_overrides.clear()


@pytest.fixture
def client(catalog):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session
