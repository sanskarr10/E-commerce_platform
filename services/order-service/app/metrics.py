"""Prometheus metrics, scraped from GET /metrics on the internal network.

The gateway never routes /metrics. Label rules: routes are the route PATTERN
("/api/orders/{order_id}"), never the raw URL, and anything
that matched no route is "unmatched". Otherwise a scanner could create unlimited label values.

Gauges that describe the database (orders per status, outbox backlog) are computed at scrape time by
a custom collector, so they are always true and cost nothing between scrapes.
"""

import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    generate_latest,
)
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.registry import Collector
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Order, Outbox, as_utc

logger = logging.getLogger("order-service")

SERVICE = "order-service"
CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
# Orders that should keep moving by themselves: an old one means a stuck saga.
UNSETTLED = ("PENDING", "STOCK_RESERVED")

registry = CollectorRegistry()
ProcessCollector(registry=registry)
PlatformCollector(registry=registry)

HTTP = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency by route and status",
    ["method", "route", "status_code"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5),
    registry=registry,
)
ORDERS_CREATED = Counter(
    "orders_created_total", "Orders placed (replays excluded)", registry=registry
)
IDEMPOTENT_REPLAYS = Counter(
    "order_idempotent_replays_total",
    "POST /api/orders retries answered with the original order",
    registry=registry,
)
EVENTS = Counter(
    "events_consumed_total",
    "Events taken off the queue, by type and outcome",
    ["type", "outcome"],
    registry=registry,
)


def route_label(request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


def observe_request(request, status_code: int, seconds: float) -> None:
    HTTP.labels(request.method, route_label(request), str(status_code)).observe(seconds)


def _age_seconds(moment: datetime | None) -> float:
    return 0.0 if moment is None else max(0.0, (datetime.now(UTC) - as_utc(moment)).total_seconds())


class DatabaseCollector(Collector):
    """A few cheap aggregate queries per scrape. Errors skip these metrics, never the scrape."""

    def __init__(self, session_factory: Callable[[], Session] | sessionmaker):
        self.session_factory = session_factory

    def collect(self) -> Iterator[GaugeMetricFamily]:
        try:
            with self.session_factory() as db:
                by_status = db.execute(
                    select(Order.status, func.count()).group_by(Order.status)
                ).all()
                oldest_unsettled = db.execute(
                    select(func.min(Order.updated_at)).where(Order.status.in_(UNSETTLED))
                ).scalar()
                backlog = db.execute(
                    select(func.count(), func.min(Outbox.created_at)).where(
                        Outbox.published_at.is_(None)
                    )
                ).one()
        except Exception as exc:
            logger.warning("metrics: database queries failed: %s", exc)
            return

        orders = GaugeMetricFamily(
            "orders_by_status", "Orders currently in each status", labels=["status"]
        )
        for status, count in by_status:
            orders.add_metric([status], count)
        yield orders
        yield GaugeMetricFamily(
            "orders_oldest_unsettled_age_seconds",
            "Age of the order that has waited longest in PENDING or STOCK_RESERVED (0 if none)",
            value=_age_seconds(oldest_unsettled),
        )
        yield GaugeMetricFamily(
            "outbox_unpublished_events",
            "Outbox rows not yet confirmed by the broker",
            value=backlog[0],
        )
        yield GaugeMetricFamily(
            "outbox_oldest_unpublished_age_seconds",
            "Age of the oldest unpublished outbox row (0 when the outbox is empty)",
            value=_age_seconds(backlog[1]),
        )


def install_database_collector(session_factory) -> DatabaseCollector:
    collector = DatabaseCollector(session_factory)
    registry.register(collector)
    return collector


def render() -> bytes:
    return generate_latest(registry)
