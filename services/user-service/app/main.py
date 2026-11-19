import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import text

from app.bootstrap import bootstrap_admin
from app.core.config import get_settings
from app.core.logging import configure_logging, request_id_ctx
from app.db import engine
from app.routers import auth, users

configure_logging()
logger = logging.getLogger("user-service")


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap_admin(get_settings())
    yield


app = FastAPI(
    title="User Service",
    version="0.1.0",
    description="Registration, login (JWT RS256 + rotating refresh tokens) and user profiles.",
    # Served under /api/users so the gateway can route by prefix without rewriting paths.
    openapi_url="/api/users/openapi.json",
    docs_url="/api/users/docs",
    redoc_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def correlation_id_and_access_log(request: Request, call_next):
    # The gateway sets X-Request-ID; reuse it so one request can be traced across services.
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    token = request_id_ctx.set(request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        if request.url.path != "/health":
            elapsed_ms = (time.perf_counter() - started) * 1000
            # Logged before the context var is reset so the JSON "request_id" field is set.
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


app.include_router(auth.router)
app.include_router(users.router)


@app.get("/health", include_in_schema=False)
def health() -> dict[str, str]:
    """Liveness: the process is up."""
    return {"status": "ok"}


@app.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    """Readiness: the database answers. Kubernetes readinessProbe points here."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable") from None
    return {"status": "ready"}
