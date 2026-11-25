"""Order creation with idempotency keys."""

import hashlib
import json
import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import metrics
from app.catalog import CatalogClient, CatalogUnavailable
from app.events.envelope import emit
from app.models import IdempotencyKey, Order, OrderItem, OrderStatusHistory
from app.schemas import OrderCreate
from app.state import PENDING


@dataclass(frozen=True)
class CreateResult:
    order: Order
    replayed: bool


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def merge_lines(payload: OrderCreate) -> dict[int, int]:
    """Duplicate product lines are merged so the same cart always means the same order."""
    lines: dict[int, int] = {}
    for item in payload.items:
        lines[item.product_id] = lines.get(item.product_id, 0) + item.quantity
    return dict(sorted(lines.items()))


def request_hash(lines: dict[int, int], payment_method: str) -> str:
    canonical = json.dumps({"lines": lines, "payment_method": payment_method}, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _existing(db: Session, user_id: uuid.UUID, key: str) -> IdempotencyKey | None:
    return db.execute(
        select(IdempotencyKey).where(IdempotencyKey.user_id == user_id, IdempotencyKey.key == key)
    ).scalar_one_or_none()


def _replay(db: Session, record: IdempotencyKey, digest: str) -> CreateResult:
    if record.request_hash != digest:
        raise _unprocessable("Idempotency-Key was already used with a different request body")
    order = db.get(Order, record.order_id)
    metrics.IDEMPOTENT_REPLAYS.inc()
    return CreateResult(order=order, replayed=True)


def create_order(
    db: Session,
    catalog: CatalogClient,
    user_id: uuid.UUID,
    key: str,
    payload: OrderCreate,
    user_email: str | None = None,
) -> CreateResult:
    lines = merge_lines(payload)
    digest = request_hash(lines, payload.payment_method)

    record = _existing(db, user_id, key)
    if record is not None:
        return _replay(db, record, digest)

    try:
        products = catalog.get_products(list(lines))
    except CatalogUnavailable:
        raise HTTPException(
            status_code=503, detail="Product catalog unavailable, try again"
        ) from None

    missing = [pid for pid in lines if pid not in products]
    if missing:
        raise _unprocessable(f"Products not found or unavailable: {missing}")
    currencies = {products[pid]["currency"] for pid in lines}
    if len(currencies) != 1:
        raise _unprocessable("All items in an order must use the same currency")
    currency = currencies.pop()

    # Prices are snapshotted from the catalog: the client never supplies them.
    total = sum(products[pid]["price_minor"] * qty for pid, qty in lines.items())
    order = Order(
        id=uuid.uuid4(),
        user_id=user_id,
        user_email=user_email,
        status=PENDING,
        total_minor=total,
        currency=currency,
        payment_method=payload.payment_method,
        items=[
            OrderItem(
                product_id=pid,
                sku=products[pid]["sku"],
                name=products[pid]["name"],
                unit_price_minor=products[pid]["price_minor"],
                quantity=qty,
            )
            for pid, qty in lines.items()
        ],
    )
    db.add(order)
    # Flush the parent first: idempotency_keys has a foreign key but no ORM relationship, so the
    # unit of work would not otherwise know to insert the order before the key.
    db.flush()
    db.add(OrderStatusHistory(order_id=order.id, from_status=None, to_status=PENDING))
    db.add(IdempotencyKey(user_id=user_id, key=key, request_hash=digest, order_id=order.id))
    emit(
        db,
        "order.created",
        {
            "order_id": str(order.id),
            "items": [{"product_id": pid, "quantity": qty} for pid, qty in lines.items()],
        },
        order.id,
    )
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request with the same key committed first: its order wins, ours is discarded.
        db.rollback()
        record = _existing(db, user_id, key)
        if record is None:
            raise
        return _replay(db, record, digest)
    metrics.ORDERS_CREATED.inc()
    return CreateResult(order=order, replayed=False)
