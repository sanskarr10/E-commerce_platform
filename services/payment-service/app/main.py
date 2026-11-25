import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from sqlalchemy import text

from app import metrics
from app.core.config import get_settings
from app.core.logging import configure_logging, request_id_ctx
from app.db import SessionLocal, engine
from app.routers import payments

configure_logging()
logger = logging.getLogger("payment-service")
metrics.install_database_collector(SessionLocal)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.messaging = None
    if settings.rabbitmq_url:
        from app.events.runtime import Messaging  # imported lazily: tests run without a broker

        app.state.messaging = Messaging(settings)
        app.state.messaging.start()
    else:
        logger.warning("RABBITMQ_URL not set: messaging disabled, no payments will be processed")
    yield
    if app.state.messaging:
        await app.state.messaging.stop()


app = FastAPI(
    title="Payment Service",
    version="0.1.0",
    description=(
        "Processes payment requests from the checkout saga against a mock provider. "
        "Read-only HTTP API: payments are created by events, not by clients."
    ),
    openapi_url="/api/payments/openapi.json",
    docs_url="/api/payments/docs",
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def correlation_id_and_access_log(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    token = request_id_ctx.set(request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        elapsed = time.perf_counter() - started
        if request.url.path not in ("/health", "/metrics"):
            metrics.observe_request(request, response.status_code, elapsed)
            elapsed_ms = elapsed * 1000
            logger.info(
                "%s %s -> %s (%.1f ms)",
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
            )
        return response
    finally:
        request_id_ctx.reset(token)


app.include_router(payments.router)


@app.get("/metrics", include_in_schema=False)
def prometheus_metrics() -> Response:
    """Scraped by Prometheus on the internal network. The gateway has no route to this path."""
    return Response(metrics.render(), media_type=metrics.CONTENT_TYPE)


@app.get("/health", include_in_schema=False)
def health() -> dict[str, str]:
    """Liveness: the process is up."""
    return {"status": "ok"}


@app.get("/ready", include_in_schema=False)
def ready(request: Request) -> dict[str, str]:
    """Readiness: the database answers. A broker outage degrades the saga, not the API."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable") from None
    messaging = request.app.state.messaging
    status = (
        "disabled" if messaging is None else ("connected" if messaging.connected else "connecting")
    )
    return {"status": "ready", "messaging": status}
