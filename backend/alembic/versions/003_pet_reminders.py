"""add pet reminders

Revision ID: 003
Revises: 002
Create Date: 2026-07-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reminders",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=True),
        sa.Column("remind_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("triggered_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_reminders_id"), "reminders", ["id"], unique=False)
    op.create_index("ix_reminders_user_id", "reminders", ["user_id"], unique=False)
    op.create_index("ix_reminders_pet_type", "reminders", ["pet_type"], unique=False)
    op.create_index("ix_reminders_remind_at", "reminders", ["remind_at"], unique=False)
    op.create_index("ix_reminders_status", "reminders", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_reminders_status", table_name="reminders")
    op.drop_index("ix_reminders_remind_at", table_name="reminders")
    op.drop_index("ix_reminders_pet_type", table_name="reminders")
    op.drop_index("ix_reminders_user_id", table_name="reminders")
    op.drop_index(op.f("ix_reminders_id"), table_name="reminders")
    op.drop_table("reminders")
