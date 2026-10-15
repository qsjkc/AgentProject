"""add pet weekly review receipts

Revision ID: 011
Revises: 010
Create Date: 2026-07-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pet_relationships",
        sa.Column("last_weekly_review_key", sa.String(length=21), nullable=True),
    )
    op.add_column(
        "pet_relationships",
        sa.Column("last_weekly_review_seen_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pet_relationships", "last_weekly_review_seen_at")
    op.drop_column("pet_relationships", "last_weekly_review_key")
