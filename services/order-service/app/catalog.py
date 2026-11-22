import logging

import httpx
from fastapi import Depends

from app.core.config import Settings, get_settings
from app.core.logging import request_id_ctx

logger = logging.getLogger("order-service")


class CatalogUnavailable(Exception):
    """The product service could not be reached or answered with an error."""


class CatalogClient:
    """Synchronous call to the product service's batch endpoint (one round trip per checkout)."""

    def __init__(self, base_url: str, timeout: float, retries: int, transport=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.transport = transport

    def get_products(self, ids: list[int]) -> dict[int, dict]:
        """Returns {id: product} for every ACTIVE product; unknown and archived ids are absent."""
        query = ",".join(str(i) for i in sorted(set(ids)))
        headers = {"X-Request-ID": request_id_ctx.get()}
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                    response = client.get(
                        f"{self.base_url}/api/products/batch",
                        params={"ids": query},
                        headers=headers,
                    )
                if response.status_code >= 500:
                    raise CatalogUnavailable(f"product service returned {response.status_code}")
                response.raise_for_status()
                return {int(p["id"]): p for p in response.json()["items"]}
            except (httpx.HTTPError, CatalogUnavailable, KeyError, ValueError) as exc:
                last = exc
                logger.warning("catalog lookup failed (attempt %d): %s", attempt + 1, exc)
        raise CatalogUnavailable(str(last))


def get_catalog(settings: Settings = Depends(get_settings)) -> CatalogClient:
    return CatalogClient(
        settings.product_service_url, settings.catalog_timeout_seconds, settings.catalog_retries
    )
