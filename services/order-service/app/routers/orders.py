import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.catalog import CatalogClient, get_catalog
from app.db import get_db
from app.deps import Principal, get_principal, require_admin
from app.events.envelope import customer_data, emit
from app.models import Order
from app.orders import create_order
from app.schemas import OrderCreate, OrderDetail, OrderOut, OrderPage
from app.state import DELIVERED, SHIPPED, InvalidTransition, transition

router = APIRouter(prefix="/api/orders", tags=["orders"])

STATUSES = {"PENDING", "STOCK_RESERVED", "PAID", "SHIPPED", "DELIVERED", "CANCELLED"}


def _page(db: Session, where: list, page: int, page_size: int) -> OrderPage:
    total = db.scalar(select(func.count()).select_from(Order).where(*where)) or 0
    rows = (
        db.execute(
            select(Order)
            .where(*where)
            .options(selectinload(Order.items))
            .order_by(Order.created_at.desc(), Order.id)
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        .scalars()
        .all()
    )
    return OrderPage(
        items=[OrderOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "",
    response_model=OrderOut,
    status_code=201,
    summary="Place an order (requires an Idempotency-Key header)",
    description=(
        "Returns 201 with status PENDING; the saga then reserves stock and takes payment "
        "asynchronously, so poll GET /api/orders/{id} for the outcome. Retrying with the same "
        "Idempotency-Key returns the original order (200, header Idempotent-Replayed: true) "
        "instead of creating a second one. Reusing a key with a different body is a 422."
    ),
)
def place_order(
    payload: OrderCreate,
    response: Response,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
    catalog: CatalogClient = Depends(get_catalog),
):
    key = (idempotency_key or "").strip()
    if not key or len(key) > 128 or not key.isprintable():
        raise HTTPException(
            status_code=400,
            detail="Idempotency-Key header is required (1-128 printable characters)",
        )
    result = create_order(db, catalog, principal.user_id, key, payload, principal.email)
    if result.replayed:
        response.status_code = 200
        response.headers["Idempotent-Replayed"] = "true"
    return result.order


@router.get("", response_model=OrderPage, summary="List my orders")
def list_my_orders(
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(20, ge=1, le=100),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    return _page(db, [Order.user_id == principal.user_id], page, page_size)


# Declared before "/{order_id}" so "admin" is never parsed as an id.
@router.get("/admin/list", response_model=OrderPage, summary="List all orders (admin)")
def list_all_orders(
    status: str | None = Query(None),
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(20, ge=1, le=100),
    _: Principal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if status is not None and status not in STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of {sorted(STATUSES)}")
    where = [Order.status == status] if status else []
    return _page(db, where, page, page_size)


@router.get(
    "/{order_id}", response_model=OrderDetail, summary="Get one order with its status history"
)
def get_order(
    order_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    order = db.get(Order, order_id)
    # Someone else's order looks exactly like a missing one: ids cannot be probed.
    if order is None or (order.user_id != principal.user_id and not principal.is_admin):
        raise HTTPException(status_code=404, detail="Order not found")
    return order


def _advance(db: Session, order_id: uuid.UUID, target: str, event: str) -> Order:
    order = db.execute(
        select(Order).where(Order.id == order_id).with_for_update()
    ).scalar_one_or_none()
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    try:
        transition(db, order, target)
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    emit(db, event, customer_data(order), order.id)
    db.commit()
    return order


@router.post(
    "/{order_id}/ship", response_model=OrderDetail, summary="Mark a paid order as shipped (admin)"
)
def ship_order(
    order_id: uuid.UUID, _: Principal = Depends(require_admin), db: Session = Depends(get_db)
):
    return _advance(db, order_id, SHIPPED, "order.shipped")


@router.post(
    "/{order_id}/deliver",
    response_model=OrderDetail,
    summary="Mark a shipped order as delivered (admin)",
)
def deliver_order(
    order_id: uuid.UUID, _: Principal = Depends(require_admin), db: Session = Depends(get_db)
):
    return _advance(db, order_id, DELIVERED, "order.delivered")
