"""Saga handlers: the order service coordinates the checkout (see docs/events/README.md).

Each handler runs inside ONE database transaction that also records the event in the inbox, so a
redelivered event is dropped and a crash leaves no half-applied state.
"""

import logging
import uuid

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.events.consumer import PermanentError
from app.events.envelope import customer_data, emit
from app.events.schemas import PAYLOADS, Envelope
from app.models import Inbox, Order
from app.state import (
    CANCELLED,
    PAID,
    PENDING,
    STOCK_RESERVED,
    transition,
)

logger = logging.getLogger("order-service")
CONSUMER = "order-service"


def claim_event(db: Session, event_id: uuid.UUID) -> bool:
    """True the first time an event is seen. The savepoint keeps the outer transaction alive."""
    try:
        with db.begin_nested():
            db.add(Inbox(event_id=event_id, consumer=CONSUMER))
            db.flush()
    except IntegrityError:
        return False
    return True


def _load_order(db: Session, order_id: uuid.UUID) -> Order:
    # FOR UPDATE: concurrent events for one order are applied one after another.
    order = db.execute(
        select(Order).where(Order.id == order_id).with_for_update()
    ).scalar_one_or_none()
    if order is None:
        # The order commits before its first event is published, so this is a contract violation.
        raise PermanentError(f"unknown order {order_id}")
    return order


def _cancel(db: Session, order: Order, reason: str) -> None:
    transition(db, order, CANCELLED, reason)
    emit(db, "order.cancelled", {**customer_data(order), "reason": reason}, order.id)


def on_stock_reserved(db: Session, order: Order, _data) -> str:
    if order.status == PENDING:
        transition(db, order, STOCK_RESERVED)
        emit(
            db,
            "payment.requested",
            {
                "order_id": str(order.id),
                "user_id": str(order.user_id),
                "amount_minor": order.total_minor,
                "currency": order.currency,
                "payment_method": order.payment_method,
            },
            order.id,
        )
        return "payment_requested"
    if order.status == CANCELLED:
        # Cancelled while the reservation was in flight: make sure the product service lets go.
        emit(
            db,
            "order.cancelled",
            {**customer_data(order), "reason": order.cancel_reason},
            order.id,
        )
        return "re_emitted_cancel"
    return "ignored"


def on_stock_failed(db: Session, order: Order, _data) -> str:
    if order.status != PENDING:
        return "ignored"
    _cancel(db, order, "out_of_stock")
    return "cancelled"


def on_payment_succeeded(db: Session, order: Order, data) -> str:
    if data.amount_minor != order.total_minor or data.currency != order.currency:
        raise PermanentError(
            f"payment of {data.amount_minor} {data.currency} does not match order total "
            f"{order.total_minor} {order.currency}"
        )
    if order.status == STOCK_RESERVED:
        transition(db, order, PAID)
        emit(
            db,
            "order.confirmed",
            {
                **customer_data(order),
                "total_minor": order.total_minor,
                "currency": order.currency,
            },
            order.id,
        )
        return "paid"
    if order.status == CANCELLED:
        # Known gap (docs/events/README.md, "Known limitations"): the customer was charged for a
        # cancelled order and needs a refund. Logged loudly so it is never silent.
        logger.error("payment succeeded for cancelled order %s: refund required", order.id)
        return "refund_required"
    return "ignored"


def on_payment_failed(db: Session, order: Order, _data) -> str:
    if order.status != STOCK_RESERVED:
        return "ignored"
    _cancel(db, order, "payment_failed")
    return "cancelled"


HANDLERS = {
    "stock.reserved": on_stock_reserved,
    "stock.failed": on_stock_failed,
    "payment.succeeded": on_payment_succeeded,
    "payment.failed": on_payment_failed,
}


def handle_event(db: Session, envelope: Envelope) -> str:
    """Applies one event and commits. Returns the outcome name (used for logging and tests)."""
    handler = HANDLERS.get(envelope.type)
    if handler is None:
        return "unknown_type"
    try:
        data = PAYLOADS[envelope.type].model_validate(envelope.data)
    except ValidationError as exc:
        raise PermanentError(f"invalid {envelope.type} payload: {exc.errors()[0]['msg']}") from None

    if not claim_event(db, envelope.id):
        db.rollback()
        return "duplicate"
    try:
        outcome = handler(db, _load_order(db, data.order_id), data)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return outcome
