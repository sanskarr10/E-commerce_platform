"""Payment saga step: charge the customer for an order, exactly once in effect.

The provider call cannot be part of a database transaction, so the flow has three steps and every
one of them is safe to repeat:

  1. Find or create the payment row (unique per order) and commit it as PENDING.
  2. Charge the provider using the payment id as the idempotency key. A retry after a crash
     returns the first result instead of charging again.
  3. In ONE transaction: lock the row, record the inbox entry, save the outcome and write the
     result event to the outbox.
"""

import logging
import time
import uuid
from collections.abc import Callable

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import metrics
from app.events.consumer import PermanentError
from app.events.envelope import emit
from app.events.schemas import PAYLOADS, Envelope
from app.models import Inbox, Payment
from app.provider import MockProvider, ProviderUnavailable

logger = logging.getLogger("payment-service")
CONSUMER = "payment-service"

PENDING = "PENDING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

SessionFactory = Callable[[], Session]


def _seen(db: Session, event_id: uuid.UUID) -> bool:
    return db.get(Inbox, event_id) is not None


def _claim(db: Session, event_id: uuid.UUID) -> bool:
    """True the first time an event is recorded. The savepoint keeps the outer transaction alive."""
    try:
        with db.begin_nested():
            db.add(Inbox(event_id=event_id, consumer=CONSUMER))
            db.flush()
    except IntegrityError:
        return False
    return True


def _find_or_create(session_factory: SessionFactory, data) -> tuple[uuid.UUID, str, int, str, str]:
    with session_factory() as db:
        payment = db.execute(
            select(Payment).where(Payment.order_id == data.order_id)
        ).scalar_one_or_none()
        if payment is None:
            payment = Payment(
                id=uuid.uuid4(),
                order_id=data.order_id,
                user_id=data.user_id,
                amount_minor=data.amount_minor,
                currency=data.currency,
                payment_method=data.payment_method,
                status=PENDING,
            )
            db.add(payment)
            try:
                db.commit()
            except IntegrityError:
                # A concurrent delivery created it first: use that row.
                db.rollback()
                payment = db.execute(
                    select(Payment).where(Payment.order_id == data.order_id)
                ).scalar_one()
        elif (payment.amount_minor, payment.currency) != (data.amount_minor, data.currency):
            # First request wins; a conflicting second request must never change what is charged.
            logger.error("payment for order %s requested again with different terms", data.order_id)
        return (
            payment.id,
            payment.status,
            payment.amount_minor,
            payment.currency,
            payment.payment_method,
        )


def handle_event(
    session_factory: SessionFactory, provider: MockProvider, envelope: Envelope
) -> str:
    """Processes one event. Returns the outcome name (used for logging and tests)."""
    if envelope.type not in PAYLOADS:
        return "unknown_type"
    try:
        data = PAYLOADS[envelope.type].model_validate(envelope.data)
    except ValidationError as exc:
        raise PermanentError(f"invalid {envelope.type} payload: {exc.errors()[0]['msg']}") from None

    with session_factory() as db:
        if _seen(db, envelope.id):
            return "duplicate"

    payment_id, status, amount, currency, method = _find_or_create(session_factory, data)

    result = None
    if status == PENDING:
        # May raise ProviderUnavailable: the delivery is retried later with the same payment id.
        started = time.perf_counter()
        try:
            result = provider.charge(str(payment_id), amount, currency, method)
        except ProviderUnavailable:
            metrics.PROVIDER_CALLS.labels("unavailable").inc()
            raise
        finally:
            metrics.PROVIDER_LATENCY.observe(time.perf_counter() - started)
        metrics.PROVIDER_CALLS.labels("succeeded" if result.succeeded else "declined").inc()

    with session_factory() as db:
        payment = db.execute(
            select(Payment).where(Payment.id == payment_id).with_for_update()
        ).scalar_one()
        if not _claim(db, envelope.id):
            db.rollback()
            return "duplicate"
        if payment.status != PENDING:
            db.commit()  # only the inbox row; another delivery already finished this payment
            return "already_processed"

        if result.succeeded:
            payment.status = SUCCEEDED
            payment.provider_ref = result.reference
            emit(
                db,
                "payment.succeeded",
                {
                    "order_id": str(payment.order_id),
                    "payment_id": str(payment.id),
                    "amount_minor": payment.amount_minor,
                    "currency": payment.currency,
                },
                payment.order_id,
            )
            outcome = "succeeded"
        else:
            payment.status = FAILED
            payment.failure_reason = result.failure_reason
            emit(
                db,
                "payment.failed",
                {
                    "order_id": str(payment.order_id),
                    "payment_id": str(payment.id),
                    "reason": result.failure_reason,
                },
                payment.order_id,
            )
            outcome = "failed"
        db.commit()
        return outcome
