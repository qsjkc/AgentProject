"""add pet relationships

Revision ID: 004
Revises: 003
Create Date: 2026-07-29
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pet_relationships",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("intimacy_xp", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("relationship_stage", sa.String(length=32), nullable=False, server_default="new_friend"),
        sa.Column("current_mood", sa.String(length=20), nullable=False, server_default="idle"),
        sa.Column("last_active_at", sa.DateTime(), nullable=True),
        sa.Column("last_greeting_at", sa.DateTime(), nullable=True),
        sa.Column("last_level_up_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "intimacy_xp >= 0",
            name="ck_pet_relationships_intimacy_xp_nonnegative",
        ),
        sa.CheckConstraint(
            "level >= 1 AND level <= 5",
            name="ck_pet_relationships_level_range",
        ),
        sa.UniqueConstraint("user_id", "pet_type", name="uq_pet_relationships_user_pet"),
    )
    op.create_index(op.f("ix_pet_relationships_id"), "pet_relationships", ["id"], unique=False)
    op.create_index("ix_pet_relationships_user_id", "pet_relationships", ["user_id"], unique=False)
    op.create_index("ix_pet_relationships_pet_type", "pet_relationships", ["pet_type"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_pet_relationships_pet_type", table_name="pet_relationships")
    op.drop_index("ix_pet_relationships_user_id", table_name="pet_relationships")
    op.drop_index(op.f("ix_pet_relationships_id"), table_name="pet_relationships")
    op.drop_table("pet_relationships")
