"""Starts and stops the consumer and the outbox relay inside the FastAPI lifespan."""

import asyncio
import logging
from contextlib import suppress

from app.core.config import Settings
from app.db import SessionLocal
from app.events.bus import RabbitBus
from app.events.handlers import handle_event
from app.events.relay import OutboxRelay, OutboxStore

logger = logging.getLogger("order-service")


async def handle(envelope) -> None:
    """Runs the (synchronous) database work in a thread so the event loop stays responsive."""

    def work() -> str:
        with SessionLocal() as db:
            return handle_event(db, envelope)

    outcome = await asyncio.to_thread(work)
    logger.info("%s -> %s", envelope.type, outcome)


class Messaging:
    def __init__(self, settings: Settings):
        self.bus = RabbitBus(
            settings.rabbitmq_url,
            handle,
            max_retries=settings.event_max_retries,
            retry_delay_ms=settings.event_retry_delay_ms,
            prefetch=settings.event_prefetch,
        )
        self.relay = OutboxRelay(
            OutboxStore(SessionLocal), self.bus.publish, settings.outbox_poll_seconds
        )
        self._tasks: list[asyncio.Task] = []

    @property
    def connected(self) -> bool:
        return self.bus.connected.is_set()

    async def _run(self) -> None:
        # The API serves requests while the broker is still starting; the outbox keeps the events.
        await self.bus.connect()
        await self.relay.run()

    def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._run()))

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with suppress(asyncio.CancelledError, Exception):
                await task
        await self.bus.close()
