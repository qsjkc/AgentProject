"""default new preferences to the pig companion

Revision ID: 015
Revises: 014
Create Date: 2026-09-27
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Change only future inserts. Existing cat/dog/pig choices stay untouched.
    op.alter_column(
        "user_preferences", "pet_type", existing_type=sa.String(length=20),
        existing_nullable=False, server_default="pig",
    )


def downgrade() -> None:
    op.alter_column(
        "user_preferences", "pet_type", existing_type=sa.String(length=20),
        existing_nullable=False, server_default="cat",
    )
