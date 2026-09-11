"""add pet intimacy events

Revision ID: 005
Revises: 004
Create Date: 2026-07-29
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pet_intimacy_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("relationship_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("xp_awarded", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("awarded_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "xp_awarded > 0",
            name="ck_pet_intimacy_events_xp_positive",
        ),
        sa.ForeignKeyConstraint(["relationship_id"], ["pet_relationships.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "idempotency_key", name="uq_pet_intimacy_events_user_key"),
    )
    op.create_index(op.f("ix_pet_intimacy_events_id"), "pet_intimacy_events", ["id"], unique=False)
    op.create_index(
        "ix_pet_intimacy_events_daily",
        "pet_intimacy_events",
        ["relationship_id", "awarded_at"],
        unique=False,
    )
    op.create_index(
        "ix_pet_intimacy_events_action_daily",
        "pet_intimacy_events",
        ["relationship_id", "action", "awarded_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_pet_intimacy_events_action_daily", table_name="pet_intimacy_events")
    op.drop_index("ix_pet_intimacy_events_daily", table_name="pet_intimacy_events")
    op.drop_index(op.f("ix_pet_intimacy_events_id"), table_name="pet_intimacy_events")
    op.drop_table("pet_intimacy_events")
