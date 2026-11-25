"""Prometheus metrics, scraped from GET /metrics on the internal network (never via the gateway).

Routes are labelled by PATTERN ("/api/users/{user_id}"), never by the raw URL, and anything that
matched no route is "unmatched", so a scanner cannot create unlimited label values.
Emails and ids are never labels.
"""

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Histogram,
    PlatformCollector,
    ProcessCollector,
    generate_latest,
)

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

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
REGISTRATIONS = Counter("user_registrations_total", "Accounts created", registry=registry)
LOGINS = Counter(
    "user_logins_total",
    "Login attempts by result (success, failure). A failure spike is a credential-stuffing signal.",
    ["result"],
    registry=registry,
)
REFRESHES = Counter(
    "user_token_refreshes_total",
    "Refresh-token use by result (success, missing, invalid, expired, replay). "
    "'replay' means an already-used token came back: a stolen cookie or an attack.",
    ["result"],
    registry=registry,
)


def route_label(request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


def observe_request(request, status_code: int, seconds: float) -> None:
    HTTP.labels(request.method, route_label(request), str(status_code)).observe(seconds)


def render() -> bytes:
    return generate_latest(registry)
