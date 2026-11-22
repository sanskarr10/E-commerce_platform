"""A mock payment provider that behaves like a real one where it matters: idempotency.

Real providers (Stripe, Razorpay, ...) accept an idempotency key and return the SAME result for a
repeated key instead of charging again. This mock does the same, so the crash-after-charge case
(charged, but the result was never saved) is safe to retry.

Test tokens (the "payment_method" of the order):
    tok_success       approved
    tok_decline       declined: card_declined
    tok_insufficient  declined: insufficient_funds
    tok_flaky         provider unavailable on the first attempt, approved on the retry
    tok_error         provider always unavailable (the message ends up in the DLQ)
    anything else     declined: invalid_payment_method
"""

import threading
import uuid
from dataclasses import dataclass


class ProviderUnavailable(Exception):
    """Transient provider failure: the saga message is retried later."""


@dataclass(frozen=True)
class ChargeResult:
    succeeded: bool
    reference: str | None = None
    failure_reason: str | None = None


DECLINES = {"tok_decline": "card_declined", "tok_insufficient": "insufficient_funds"}


class MockProvider:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._results: dict[str, ChargeResult] = {}
        self._attempts: dict[str, int] = {}
        self.approved_charges = 0  # real money moved; tests assert it never exceeds one per order

    def charge(
        self, idempotency_key: str, amount_minor: int, currency: str, token: str
    ) -> ChargeResult:
        with self._lock:
            if idempotency_key in self._results:
                return self._results[idempotency_key]  # replay: no second charge
            attempt = self._attempts[idempotency_key] = self._attempts.get(idempotency_key, 0) + 1
            if token == "tok_error" or (token == "tok_flaky" and attempt == 1):
                raise ProviderUnavailable("provider timed out")
            if token in ("tok_success", "tok_flaky"):
                result = ChargeResult(True, reference=f"ch_{uuid.uuid4().hex[:20]}")
                self.approved_charges += 1
            else:
                result = ChargeResult(
                    False, failure_reason=DECLINES.get(token, "invalid_payment_method")
                )
            self._results[idempotency_key] = result
            return result


_provider = MockProvider()


def get_provider() -> MockProvider:
    return _provider
