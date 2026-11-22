import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings
from app.core.security import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)
ROLE_ADMIN = "admin"


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN


def unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    settings: Settings = Depends(get_settings),
) -> Principal:
    """Verifies the JWT with the user-service PUBLIC key. No call to the user service is needed."""
    if credentials is None:
        raise unauthorized()
    try:
        claims = decode_access_token(credentials.credentials, settings)
        return Principal(user_id=uuid.UUID(claims["sub"]), role=str(claims.get("role", "")))
    except (jwt.PyJWTError, ValueError, KeyError):
        raise unauthorized("Invalid or expired token") from None


def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return principal
