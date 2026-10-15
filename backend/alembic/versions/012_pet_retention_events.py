"""add privacy-minimal pet retention events

Revision ID: 012
Revises: 011
Create Date: 2026-08-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pet_retention_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("event_type", sa.String(length=48), nullable=False),
        sa.Column("review_key", sa.String(length=21), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "event_type IN ("
            "'weekly_review_generated', "
            "'weekly_review_shown', "
            "'weekly_review_seen', "
            "'weekly_review_follow_up_care', "
            "'weekly_review_follow_up_chat', "
            "'weekly_review_follow_up_reminder'"
            ")",
            name="ck_pet_retention_events_type",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "pet_type",
            "event_type",
            "review_key",
            name="uq_pet_retention_events_funnel_step",
        ),
    )
    op.create_index(
        op.f("ix_pet_retention_events_id"),
        "pet_retention_events",
        ["id"],
        unique=False,
    )
    op.create_index(
        "ix_pet_retention_events_funnel",
        "pet_retention_events",
        ["event_type", "occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_pet_retention_events_funnel", table_name="pet_retention_events")
    op.drop_index(op.f("ix_pet_retention_events_id"), table_name="pet_retention_events")
    op.drop_table("pet_retention_events")
