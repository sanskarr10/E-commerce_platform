import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# BIGINT primary keys do not auto-increment on SQLite, so tests use INTEGER there.
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


def utcnow() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; PostgreSQL returns aware ones. Normalise both."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class Payment(Base):
    """One payment per order: the unique order_id stops a duplicate event charging twice."""

    __tablename__ = "payments"

    # Also the idempotency key sent to the payment provider.
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    order_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    # A provider token such as "tok_success". Never a card number.
    payment_method: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), index=True)
    provider_ref: Mapped[str | None] = mapped_column(String(64), default=None)
    failure_reason: Mapped[str | None] = mapped_column(String(64), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Outbox(Base):
    """Events are written in the same transaction as the state change, then relayed to RabbitMQ."""

    __tablename__ = "outbox"
    __table_args__ = (
        # Partial index: the relay only ever scans unpublished rows.
        Index("ix_outbox_unpublished", "seq", postgresql_where=text("published_at IS NULL")),
    )

    seq: Mapped[int] = mapped_column(BigIntPK, primary_key=True, autoincrement=True)
    id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True)
    event_type: Mapped[str] = mapped_column(String(64))
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Lease: a relay that dies mid-batch does not block its rows forever.
    claimed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class Inbox(Base):
    """Event ids already handled: the primary key turns a redelivery into a no-op."""

    __tablename__ = "inbox"

    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    consumer: Mapped[str] = mapped_column(String(64))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
