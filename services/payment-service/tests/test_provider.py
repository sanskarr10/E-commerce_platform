import pytest

from app.provider import MockProvider, ProviderUnavailable


def charge(provider, key="k1", token="tok_success"):
    return provider.charge(key, 1000, "INR", token)


def test_approves_and_declines_by_token():
    p = MockProvider()
    assert charge(p).succeeded and charge(p).reference.startswith("ch_")
    assert charge(p, "k2", "tok_decline").failure_reason == "card_declined"
    assert charge(p, "k3", "tok_insufficient").failure_reason == "insufficient_funds"
    assert charge(p, "k4", "tok_whatever").failure_reason == "invalid_payment_method"


def test_same_idempotency_key_returns_the_same_result_without_charging_again():
    p = MockProvider()
    first, second = charge(p), charge(p)
    assert first == second
    assert p.approved_charges == 1


def test_flaky_fails_once_then_succeeds_and_error_never_does():
    p = MockProvider()
    with pytest.raises(ProviderUnavailable):
        charge(p, "f", "tok_flaky")
    assert charge(p, "f", "tok_flaky").succeeded
    for _ in range(3):
        with pytest.raises(ProviderUnavailable):
            charge(p, "e", "tok_error")
    assert p.approved_charges == 1


def test_declines_are_remembered_too():
    p = MockProvider()
    assert charge(p, "d", "tok_decline") is charge(p, "d", "tok_decline")
