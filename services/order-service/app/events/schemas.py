import uuid

from pydantic import BaseModel, ConfigDict


class Envelope(BaseModel):
    # Tolerant reader: unknown fields are ignored so producers can add fields safely.
    model_config = ConfigDict(extra="ignore")

    id: uuid.UUID
    type: str
    version: int
    occurred_at: str
    correlation_id: uuid.UUID
    data: dict


class _Payload(BaseModel):
    model_config = ConfigDict(extra="ignore")


class StockReserved(_Payload):
    order_id: uuid.UUID


class StockFailure(_Payload):
    product_id: int
    reason: str


class StockFailed(_Payload):
    order_id: uuid.UUID
    failures: list[StockFailure]


class PaymentSucceeded(_Payload):
    order_id: uuid.UUID
    payment_id: uuid.UUID
    amount_minor: int
    currency: str


class PaymentFailed(_Payload):
    order_id: uuid.UUID
    payment_id: uuid.UUID
    reason: str


PAYLOADS = {
    "stock.reserved": StockReserved,
    "stock.failed": StockFailed,
    "payment.succeeded": PaymentSucceeded,
    "payment.failed": PaymentFailed,
}
