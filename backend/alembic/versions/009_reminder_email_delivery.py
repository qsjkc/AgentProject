"""add reminder email delivery

Revision ID: 009
Revises: 008
Create Date: 2026-07-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing reminders stay disabled to avoid sending a backlog during rollout.
    op.add_column(
        "reminders",
        sa.Column(
            "email_enabled",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )
    op.add_column(
        "reminders",
        sa.Column(
            "email_status",
            sa.String(length=20),
            server_default="disabled",
            nullable=False,
        ),
    )
    op.add_column("reminders", sa.Column("email_sent_at", sa.DateTime(), nullable=True))
    op.add_column("reminders", sa.Column("email_claimed_at", sa.DateTime(), nullable=True))
    op.add_column(
        "reminders",
        sa.Column("email_claim_token", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "reminders",
        sa.Column(
            "email_attempt_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
    )
    op.add_column(
        "reminders",
        sa.Column("email_next_attempt_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "reminders",
        sa.Column("email_last_error", sa.String(length=500), nullable=True),
    )
    op.create_index(
        "ix_reminders_email_delivery",
        "reminders",
        [
            "status",
            "email_enabled",
            "email_status",
            "remind_at",
            "email_next_attempt_at",
        ],
        unique=False,
    )
    op.alter_column("reminders", "email_enabled", server_default=sa.true())
    op.alter_column("reminders", "email_status", server_default="pending")


def downgrade() -> None:
    op.drop_index("ix_reminders_email_delivery", table_name="reminders")
    op.drop_column("reminders", "email_last_error")
    op.drop_column("reminders", "email_next_attempt_at")
    op.drop_column("reminders", "email_attempt_count")
    op.drop_column("reminders", "email_claim_token")
    op.drop_column("reminders", "email_claimed_at")
    op.drop_column("reminders", "email_sent_at")
    op.drop_column("reminders", "email_status")
    op.drop_column("reminders", "email_enabled")
