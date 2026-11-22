"""The order state machine. Every status change goes through `transition`."""

from sqlalchemy.orm import Session

from app.models import Order, OrderStatusHistory

PENDING = "PENDING"
STOCK_RESERVED = "STOCK_RESERVED"
PAID = "PAID"
SHIPPED = "SHIPPED"
DELIVERED = "DELIVERED"
CANCELLED = "CANCELLED"

ALLOWED: dict[str, set[str]] = {
    PENDING: {STOCK_RESERVED, CANCELLED},
    STOCK_RESERVED: {PAID, CANCELLED},
    PAID: {SHIPPED},
    SHIPPED: {DELIVERED},
    DELIVERED: set(),
    CANCELLED: set(),
}


class InvalidTransition(Exception):
    def __init__(self, current: str, target: str):
        super().__init__(f"Cannot move an order from {current} to {target}")
        self.current = current
        self.target = target


def transition(db: Session, order: Order, target: str, reason: str | None = None) -> None:
    """Validates the move, applies it and records it in the history."""
    if target not in ALLOWED.get(order.status, set()):
        raise InvalidTransition(order.status, target)
    db.add(
        OrderStatusHistory(
            order_id=order.id, from_status=order.status, to_status=target, reason=reason
        )
    )
    order.status = target
    if target == CANCELLED:
        order.cancel_reason = reason
