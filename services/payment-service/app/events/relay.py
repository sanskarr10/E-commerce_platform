import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.models import Outbox, utcnow

logger = logging.getLogger("payment-service")
BATCH = 50
LEASE = timedelta(seconds=30)

Publish = Callable[[str, str, str], Awaitable[None]]  # (routing_key, body, message_id)


class OutboxStore:
    """Database side of the outbox relay (synchronous; called through a thread from async code)."""

    def __init__(self, session_factory: sessionmaker[Session]):
        self.session_factory = session_factory

    def claim(self, limit: int = BATCH) -> list[tuple[int, str, str, str]]:
        """Leases unpublished rows in seq order. SKIP LOCKED lets replicas share the table."""
        with self.session_factory() as db:
            now = utcnow()
            rows = (
                db.execute(
                    select(Outbox)
                    .where(
                        Outbox.published_at.is_(None),
                        (Outbox.claimed_until.is_(None)) | (Outbox.claimed_until < now),
                    )
                    .order_by(Outbox.seq)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
                .scalars()
                .all()
            )
            claimed = [(r.seq, str(r.id), r.event_type, r.payload) for r in rows]
            if rows:
                db.execute(
                    update(Outbox)
                    .where(Outbox.seq.in_([r.seq for r in rows]))
                    .values(claimed_until=now + LEASE)
                )
            db.commit()
            return claimed

    def mark_published(self, seqs: list[int]) -> None:
        if not seqs:
            return
        with self.session_factory() as db:
            db.execute(
                update(Outbox)
                .where(Outbox.seq.in_(seqs))
                .values(published_at=utcnow(), claimed_until=None)
            )
            db.commit()

    def release(self, seqs: list[int]) -> None:
        """Gives rows back immediately instead of waiting for the lease to expire."""
        if not seqs:
            return
        with self.session_factory() as db:
            db.execute(
                update(Outbox)
                .where(Outbox.seq.in_(seqs), Outbox.published_at.is_(None))
                .values(claimed_until=None)
            )
            db.commit()


class OutboxRelay:
    """Publishes outbox rows in order, marking each one only AFTER the broker confirmed it.

    A crash between "published" and "marked" produces a duplicate (dropped by the consumer's inbox),
    never a lost event. On the first failure the rest of the batch is released to keep ordering.
    """

    def __init__(self, store: OutboxStore, publish: Publish, interval: float = 0.5):
        self.store = store
        self.publish = publish
        self.interval = interval

    async def flush(self) -> int:
        rows = await asyncio.to_thread(self.store.claim)
        done: list[int] = []
        try:
            for seq, event_id, event_type, payload in rows:
                await self.publish(event_type, payload, event_id)
                done.append(seq)
        except Exception as exc:
            logger.warning("outbox publish failed, will retry: %s", exc)
        finally:
            await asyncio.to_thread(self.store.mark_published, done)
            await asyncio.to_thread(
                self.store.release, [seq for seq, *_ in rows if seq not in done]
            )
        return len(done)

    async def run(self) -> None:
        while True:
            published = 0
            try:
                published = await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("outbox relay pass failed: %s", exc)
            if published == 0:
                await asyncio.sleep(self.interval)
