from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_url = get_settings().database_url
_is_sqlite = _url.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(_url, pool_pre_ping=True, connect_args=_connect_args)

if _is_sqlite:
    # pysqlite's default transaction handling breaks SAVEPOINT. This is the documented recipe
    # (SQLAlchemy "Serializable isolation / Savepoints / Transactional DDL"). The unit tests run on
    # SQLite and rely on savepoints for the idempotent inbox; production runs on PostgreSQL.
    @event.listens_for(engine, "connect")
    def _no_implicit_begin(dbapi_connection, _record):
        dbapi_connection.isolation_level = None
        dbapi_connection.execute("PRAGMA foreign_keys=ON")  # enforce FKs like PostgreSQL does

    @event.listens_for(engine, "begin")
    def _explicit_begin(conn):
        conn.exec_driver_sql("BEGIN")


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
