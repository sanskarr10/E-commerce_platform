"""RabbitMQ adapter (aio-pika). Everything decision-related lives in consumer.py and handlers.py."""

import asyncio
import logging

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from app.events.consumer import process_delivery
from app.events.envelope import CONSUMED_TYPES, EXCHANGE, QUEUE

logger = logging.getLogger("order-service")


async def declare_topology(channel, retry_delay_ms: int):
    """Idempotent. Topic exchange -> order-service.events, plus a retry TTL queue and a DLQ."""
    exchange = await channel.declare_exchange(EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True)
    queue = await channel.declare_queue(QUEUE, durable=True)
    await channel.declare_queue(
        f"{QUEUE}.retry",
        durable=True,
        arguments={
            "x-message-ttl": retry_delay_ms,
            "x-dead-letter-exchange": "",  # the default exchange routes by queue name
            "x-dead-letter-routing-key": QUEUE,
        },
    )
    await channel.declare_queue(f"{QUEUE}.dlq", durable=True)
    for key in CONSUMED_TYPES:
        await queue.bind(exchange, routing_key=key)
    return exchange, queue


class RabbitBus:
    def __init__(self, url: str, handle, *, max_retries: int, retry_delay_ms: int, prefetch: int):
        self.url = url
        self.handle = handle
        self.max_retries = max_retries
        self.retry_delay_ms = retry_delay_ms
        self.prefetch = prefetch
        self.connection = None
        self.exchange = None
        self.channel = None
        self.connected = asyncio.Event()

    async def connect(self, attempts: int = 60, delay: float = 2.0) -> None:
        """Keeps trying at startup: in Docker Compose the broker may still be booting."""
        for attempt in range(1, attempts + 1):
            try:
                # connect_robust re-establishes the connection and consumers after a broker restart.
                self.connection = await aio_pika.connect_robust(self.url)
                break
            except Exception as exc:
                if attempt == attempts:
                    raise
                logger.warning("rabbitmq not reachable (attempt %d/%d): %s", attempt, attempts, exc)
                await asyncio.sleep(delay)
        self.channel = await self.connection.channel(publisher_confirms=True)
        await self.channel.set_qos(prefetch_count=self.prefetch)
        self.exchange, queue = await declare_topology(self.channel, self.retry_delay_ms)
        await queue.consume(self._on_message)
        self.connected.set()
        logger.info("rabbitmq connected, consuming %s", QUEUE)

    async def publish(self, routing_key: str, body: str, message_id: str) -> None:
        """Returns only after the broker confirmed the message (publisher confirm)."""
        message = aio_pika.Message(
            body.encode(),
            content_type="application/json",
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            message_id=message_id,
            type=routing_key,
        )
        await self.exchange.publish(message, routing_key=routing_key)

    async def _send_to_queue(
        self, queue: str, message: AbstractIncomingMessage, headers: dict
    ) -> None:
        await self.channel.default_exchange.publish(
            aio_pika.Message(
                message.body,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                headers=headers,
            ),
            routing_key=queue,
        )

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        try:
            retries = int((message.headers or {}).get("x-retries", 0))
            decision = await process_delivery(message.body, retries, self.handle, self.max_retries)
            # Re-publish BEFORE acking: a crash in between duplicates, never loses, the message.
            if decision.action == "retry":
                headers = {**(message.headers or {}), "x-retries": decision.attempt}
                await self._send_to_queue(f"{QUEUE}.retry", message, headers)
            elif decision.action == "dead_letter":
                headers = {**(message.headers or {}), "x-dead-letter-reason": decision.reason}
                await self._send_to_queue(f"{QUEUE}.dlq", message, headers)
            await message.ack()
        except Exception as exc:
            logger.error("failed to settle message, requeueing: %s", exc)
            await message.nack(requeue=True)

    async def close(self) -> None:
        if self.connection is not None:
            await self.connection.close()
