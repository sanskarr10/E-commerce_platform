import itertools

import pytest

from app.models import Order
from app.state import ALLOWED, InvalidTransition, transition


def make(status):
    import uuid

    return Order(id=uuid.uuid4(), user_id=uuid.uuid4(), status=status)


class FakeDb:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)


# Written out by hand on purpose: deriving the expectation from ALLOWED would let a wrong
# table pass its own test.
EXPECTED = {
    "PENDING": {"STOCK_RESERVED", "CANCELLED"},
    "STOCK_RESERVED": {"PAID", "CANCELLED"},
    "PAID": {"SHIPPED"},
    "SHIPPED": {"DELIVERED"},
    "DELIVERED": set(),
    "CANCELLED": set(),
}


def test_the_transition_table_is_exactly_the_documented_state_machine():
    assert ALLOWED == EXPECTED


def test_every_allowed_move_works_and_is_recorded():
    for current, targets in EXPECTED.items():
        for target in targets:
            order, db = make(current), FakeDb()
            transition(db, order, target, "why")
            assert order.status == target
            assert (db.added[0].from_status, db.added[0].to_status) == (current, target)


def test_every_other_move_is_rejected_and_changes_nothing():
    states = list(EXPECTED)
    for current, target in itertools.product(states, states):
        if target in EXPECTED[current]:
            continue
        order, db = make(current), FakeDb()
        with pytest.raises(InvalidTransition):
            transition(db, order, target)
        assert order.status == current
        assert db.added == []


def test_terminal_states_have_no_exits():
    assert ALLOWED["DELIVERED"] == set()
    assert ALLOWED["CANCELLED"] == set()


def test_cancel_reason_is_stored_only_on_cancel():
    order, db = make("PENDING"), FakeDb()
    transition(db, order, "CANCELLED", "out_of_stock")
    assert order.cancel_reason == "out_of_stock"
    paid = make("STOCK_RESERVED")
    transition(FakeDb(), paid, "PAID", "ignored")
    assert paid.cancel_reason is None
