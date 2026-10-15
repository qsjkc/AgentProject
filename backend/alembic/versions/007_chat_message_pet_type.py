"""track pet type on chat messages

Revision ID: 007
Revises: 006
Create Date: 2026-07-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_messages",
        sa.Column("pet_type", sa.String(length=20), nullable=True),
    )
    op.create_index(
        "ix_chat_messages_pet_daily",
        "chat_messages",
        ["pet_type", "role", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_messages_pet_daily", table_name="chat_messages")
    op.drop_column("chat_messages", "pet_type")
