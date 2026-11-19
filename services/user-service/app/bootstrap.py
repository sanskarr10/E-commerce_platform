import logging

from sqlalchemy import select

from app.core.config import Settings
from app.core.security import hash_password
from app.db import SessionLocal
from app.models import ROLE_ADMIN, User

logger = logging.getLogger(__name__)


def bootstrap_admin(settings: Settings) -> bool:
    """Create the first admin from ADMIN_EMAIL / ADMIN_PASSWORD. Idempotent. True if created."""
    if not settings.admin_email or not settings.admin_password:
        return False
    email = settings.admin_email.lower()
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.email == email)):
            return False
        db.add(
            User(
                email=email,
                hashed_password=hash_password(settings.admin_password),
                full_name="Administrator",
                role=ROLE_ADMIN,
            )
        )
        db.commit()
    logger.info("Bootstrap admin created: %s", email)
    return True
