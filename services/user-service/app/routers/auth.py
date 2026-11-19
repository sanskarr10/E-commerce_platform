from datetime import timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.security import (
    DUMMY_HASH,
    create_access_token,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from app.db import get_db
from app.deps import unauthorized
from app.models import RefreshToken, User, as_utc, utcnow
from app.schemas import LoginIn, RegisterIn, TokenOut, UserOut

router = APIRouter(prefix="/api/users", tags=["auth"])

REFRESH_COOKIE = "refresh_token"
COOKIE_PATH = "/api/users"  # the browser only sends it to auth endpoints


def _issue_tokens(user: User, db: Session, response: Response, settings: Settings) -> TokenOut:
    raw = new_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_refresh_token(raw),
            expires_at=utcnow() + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    db.commit()
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=raw,
        max_age=settings.refresh_token_ttl_days * 86400,
        httponly=True,  # not readable from JavaScript, so XSS cannot steal it
        secure=settings.use_secure_cookies,
        samesite="lax",
        path=COOKIE_PATH,
    )
    access_token, expires_in = create_access_token(user, settings)
    return TokenOut(access_token=access_token, expires_in=expires_in)


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(body: RegisterIn, db: Session = Depends(get_db)) -> User:
    email = body.email.lower()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    user = User(email=email, hashed_password=hash_password(body.password), full_name=body.full_name)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:  # two simultaneous registrations for the same email
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
        ) from None
    return user


@router.post("/login", response_model=TokenOut)
def login(
    body: LoginIn,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TokenOut:
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    password_ok = verify_password(body.password, user.hashed_password if user else DUMMY_HASH)
    if user is None or not password_ok or not user.is_active:
        raise unauthorized("Invalid email or password")
    return _issue_tokens(user, db, response, settings)


@router.post("/refresh", response_model=TokenOut)
def refresh(
    response: Response,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TokenOut:
    """Rotate the refresh token: each one can be used exactly once."""
    if not refresh_token:
        raise unauthorized("Missing refresh token")

    row = db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(refresh_token))
    )
    if row is None:
        raise unauthorized("Invalid refresh token")

    if row.revoked_at is not None:
        # An already-used token came back: either a replay attack or a stolen cookie.
        # Revoke every session of this user so the attacker's copy dies too.
        db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == row.user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=utcnow())
        )
        db.commit()
        raise unauthorized("Invalid refresh token")

    if as_utc(row.expires_at) <= utcnow():
        raise unauthorized("Refresh token expired")

    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise unauthorized("Invalid refresh token")

    row.revoked_at = utcnow()
    return _issue_tokens(user, db, response, settings)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> None:
    if refresh_token:
        row = db.scalar(
            select(RefreshToken).where(
                RefreshToken.token_hash == hash_refresh_token(refresh_token),
                RefreshToken.revoked_at.is_(None),
            )
        )
        if row:
            row.revoked_at = utcnow()
            db.commit()
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)
