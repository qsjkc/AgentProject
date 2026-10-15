"""add pet activity events

Revision ID: 008
Revises: 007
Create Date: 2026-07-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pet_activity_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("relationship_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["relationship_id"],
            ["pet_relationships.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_pet_activity_events_user_key",
        ),
    )
    op.create_index(
        op.f("ix_pet_activity_events_id"),
        "pet_activity_events",
        ["id"],
        unique=False,
    )
    op.create_index(
        "ix_pet_activity_events_daily",
        "pet_activity_events",
        ["relationship_id", "occurred_at"],
        unique=False,
    )
    op.create_index(
        "ix_pet_activity_events_action_daily",
        "pet_activity_events",
        ["relationship_id", "action", "occurred_at"],
        unique=False,
    )
    op.execute(
        sa.text(
            """
            INSERT INTO pet_activity_events (
                user_id,
                relationship_id,
                pet_type,
                action,
                idempotency_key,
                occurred_at
            )
            SELECT
                user_id,
                relationship_id,
                pet_type,
                action,
                idempotency_key,
                awarded_at
            FROM pet_intimacy_events
            WHERE action NOT IN ('reminder_created', 'reminder_completed', 'meaningful_chat')
            """
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_pet_activity_events_action_daily",
        table_name="pet_activity_events",
    )
    op.drop_index("ix_pet_activity_events_daily", table_name="pet_activity_events")
    op.drop_index(op.f("ix_pet_activity_events_id"), table_name="pet_activity_events")
    op.drop_table("pet_activity_events")
