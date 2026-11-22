import json
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import Outbox

EXCHANGE = "ecommerce.events"
QUEUE = "order-service.events"
CONSUMED_TYPES = ["stock.reserved", "stock.failed", "payment.succeeded", "payment.failed"]


def build_envelope(event_type: str, data: dict, correlation_id: uuid.UUID | str) -> dict:
    """Envelope as described in docs/events/README.md."""
    return {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "version": 1,
        "occurred_at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "correlation_id": str(correlation_id),
        "data": data,
    }


def emit(db: Session, event_type: str, data: dict, correlation_id: uuid.UUID | str) -> dict:
    """Writes the event to the outbox; it is published only if the transaction commits."""
    envelope = build_envelope(event_type, data, correlation_id)
    db.add(
        Outbox(
            id=uuid.UUID(envelope["id"]),
            event_type=event_type,
            payload=json.dumps(envelope, separators=(",", ":")),
        )
    )
    return envelope
