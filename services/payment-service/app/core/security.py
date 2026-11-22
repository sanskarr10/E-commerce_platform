import jwt

from app.core.config import Settings

ALGORITHM = "RS256"


def decode_access_token(token: str, settings: Settings) -> dict:
    """Raises jwt.PyJWTError on any problem. The algorithm is pinned to RS256."""
    return jwt.decode(
        token,
        settings.public_key,
        algorithms=[ALGORITHM],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
        options={"require": ["exp", "iat", "sub"]},
    )
