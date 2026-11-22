import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class OrderItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: int = Field(gt=0)
    quantity: int = Field(ge=1, le=1000)


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[OrderItemIn] = Field(min_length=1, max_length=50)
    # A provider token (tok_success, tok_decline, ...). Never send raw card numbers to this API.
    payment_method: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    product_id: int
    sku: str
    name: str
    unit_price_minor: int
    quantity: int


class HistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    from_status: str | None
    to_status: str
    reason: str | None
    created_at: datetime


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    status: str
    total_minor: int
    currency: str
    cancel_reason: str | None
    items: list[OrderItemOut]
    created_at: datetime
    updated_at: datetime


class OrderDetail(OrderOut):
    history: list[HistoryOut]


class OrderPage(BaseModel):
    items: list[OrderOut]
    total: int
    page: int
    page_size: int
