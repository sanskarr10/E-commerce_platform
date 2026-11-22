from functools import cached_property, lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """12-factor config: everything comes from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    database_url: str

    # This service only verifies tokens, so it only ever needs the PUBLIC key.
    jwt_public_key_path: str
    jwt_issuer: str = "ecommerce-user-service"
    jwt_audience: str = "ecommerce"

    # Empty disables messaging: the HTTP API still works, but no payments are processed.
    rabbitmq_url: str = ""
    event_max_retries: int = 5
    event_retry_delay_ms: int = 5000
    event_prefetch: int = 10
    outbox_poll_seconds: float = 0.5

    @cached_property
    def public_key(self) -> str:
        return Path(self.jwt_public_key_path).read_text()


@lru_cache
def get_settings() -> Settings:
    return Settings()
