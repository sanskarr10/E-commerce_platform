import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PaymentOut(BaseModel):
    """The payment method token is never returned."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    order_id: uuid.UUID
    user_id: uuid.UUID
    amount_minor: int
    currency: str
    status: str
    provider_ref: str | None
    failure_reason: str | None
    created_at: datetime
    updated_at: datetime


class PaymentPage(BaseModel):
    items: list[PaymentOut]
    total: int
    page: int
    page_size: int
