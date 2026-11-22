import uuid

from pydantic import BaseModel, ConfigDict, Field


class Envelope(BaseModel):
    # Tolerant reader: unknown fields are ignored so producers can add fields safely.
    model_config = ConfigDict(extra="ignore")

    id: uuid.UUID
    type: str
    version: int
    occurred_at: str
    correlation_id: uuid.UUID
    data: dict


class PaymentRequested(BaseModel):
    model_config = ConfigDict(extra="ignore")

    order_id: uuid.UUID
    user_id: uuid.UUID
    amount_minor: int = Field(gt=0)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    payment_method: str = Field(min_length=1, max_length=64)


PAYLOADS = {"payment.requested": PaymentRequested}
