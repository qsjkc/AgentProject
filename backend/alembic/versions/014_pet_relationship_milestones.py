"""add pet relationship milestones

Revision ID: 014
Revises: 013
Create Date: 2026-08-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pet_relationship_milestones",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("relationship_id", sa.Integer(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("reward_outfit_id", sa.String(length=64), nullable=False),
        sa.Column("achieved_at", sa.DateTime(), nullable=False),
        sa.Column("claim_token", sa.String(length=36), nullable=True),
        sa.Column("claim_expires_at", sa.DateTime(), nullable=True),
        sa.Column("acknowledged_at", sa.DateTime(), nullable=True),
        sa.CheckConstraint(
            "level >= 2 AND level <= 5",
            name="ck_pet_relationship_milestones_level_range",
        ),
        sa.ForeignKeyConstraint(
            ["relationship_id"],
            ["pet_relationships.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "relationship_id",
            "claim_token",
            name="uq_pet_relationship_milestones_relationship_claim_token",
        ),
        sa.UniqueConstraint(
            "relationship_id",
            "level",
            name="uq_pet_relationship_milestones_relationship_level",
        ),
    )
    op.create_index(
        op.f("ix_pet_relationship_milestones_id"),
        "pet_relationship_milestones",
        ["id"],
        unique=False,
    )
    op.create_index(
        "ix_pet_relationship_milestones_pending",
        "pet_relationship_milestones",
        ["relationship_id", "acknowledged_at", "level"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_pet_relationship_milestones_pending",
        table_name="pet_relationship_milestones",
    )
    op.drop_index(
        op.f("ix_pet_relationship_milestones_id"),
        table_name="pet_relationship_milestones",
    )
    op.drop_table("pet_relationship_milestones")
