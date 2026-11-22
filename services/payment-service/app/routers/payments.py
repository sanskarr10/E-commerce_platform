import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import Principal, get_principal, require_admin
from app.models import Payment
from app.schemas import PaymentOut, PaymentPage

router = APIRouter(prefix="/api/payments", tags=["payments"])

STATUSES = {"PENDING", "SUCCEEDED", "FAILED"}


# Payments are created by the saga (a payment.requested event), never by a client request, so
# there is no POST here: the HTTP API is read-only.
@router.get("/admin/list", response_model=PaymentPage, summary="List all payments (admin)")
def list_payments(
    status: str | None = Query(None),
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(20, ge=1, le=100),
    _: Principal = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if status is not None and status not in STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of {sorted(STATUSES)}")
    where = [Payment.status == status] if status else []
    total = db.scalar(select(func.count()).select_from(Payment).where(*where)) or 0
    rows = (
        db.execute(
            select(Payment)
            .where(*where)
            .order_by(Payment.created_at.desc(), Payment.id)
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
        .scalars()
        .all()
    )
    return PaymentPage(
        items=[PaymentOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/orders/{order_id}", response_model=PaymentOut, summary="Get the payment for an order")
def get_payment_for_order(
    order_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    payment = db.execute(select(Payment).where(Payment.order_id == order_id)).scalar_one_or_none()
    # Someone else's payment looks exactly like a missing one.
    if payment is None or (payment.user_id != principal.user_id and not principal.is_admin):
        raise HTTPException(status_code=404, detail="Payment not found")
    return payment
