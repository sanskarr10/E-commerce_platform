from functools import cached_property, lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """12-factor config: everything comes from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    database_url: str

    # RS256 key pair. user-service signs with the private key; every other service
    # only needs the public key to verify tokens on its own.
    jwt_private_key_path: str
    jwt_public_key_path: str
    jwt_issuer: str = "ecommerce-user-service"
    jwt_audience: str = "ecommerce"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 7

    # Defaults to "secure cookies everywhere except local development and tests".
    cookie_secure: bool | None = None

    # Optional bootstrap admin, created on startup if it does not exist yet.
    admin_email: str = ""
    admin_password: str = ""

    @cached_property
    def private_key(self) -> str:
        return Path(self.jwt_private_key_path).read_text()

    @cached_property
    def public_key(self) -> str:
        return Path(self.jwt_public_key_path).read_text()

    @property
    def use_secure_cookies(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment not in {"development", "test"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
