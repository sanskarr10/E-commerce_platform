import json
import logging
from dataclasses import dataclass

from pydantic import ValidationError

from app import metrics
from app.events.schemas import Envelope

logger = logging.getLogger("payment-service")


class PermanentError(Exception):
    """Raised by a handler when retrying cannot help: the message goes straight to the DLQ."""


@dataclass(frozen=True)
class Decision:
    action: str  # "ack" | "retry" | "dead_letter"
    attempt: int = 0
    reason: str = ""


async def process_delivery(body: bytes, retries: int, handle, max_retries: int) -> Decision:
    """Decides what to do with one delivery, independent of any broker details.

    `handle` is an async callable taking the parsed Envelope.
    """
    try:
        envelope = Envelope.model_validate(json.loads(body))
    except (ValueError, ValidationError):
        logger.error("malformed event, dead-lettering")
        metrics.EVENTS.labels("unknown", "dead_letter").inc()
        return Decision("dead_letter", reason="malformed_envelope")

    try:
        outcome = await handle(envelope)
        metrics.EVENTS.labels(envelope.type, outcome or "processed").inc()
        return Decision("ack")
    except PermanentError as exc:
        logger.error("event %s rejected: %s", envelope.type, exc)
        metrics.EVENTS.labels(envelope.type, "dead_letter").inc()
        return Decision("dead_letter", reason="permanent_error")
    except Exception as exc:
        if retries >= max_retries:
            logger.error(
                "event %s failed %d times, dead-lettering: %s", envelope.type, retries + 1, exc
            )
            metrics.EVENTS.labels(envelope.type, "dead_letter").inc()
            return Decision("dead_letter", reason="retries_exhausted")
        logger.warning("event %s failed, will retry: %s", envelope.type, exc)
        metrics.EVENTS.labels(envelope.type, "retry").inc()
        return Decision("retry", attempt=retries + 1)
