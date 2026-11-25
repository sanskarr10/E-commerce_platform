"""snapshot the customer email on the order (for notifications)

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-22
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("user_email", sa.String(length=320), nullable=True))


def downgrade() -> None:
    op.drop_column("orders", "user_email")
