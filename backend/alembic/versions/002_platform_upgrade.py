"""platform upgrade

Revision ID: 002
Revises: 001
Create Date: 2026-04-11
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("status", sa.String(length=20), nullable=False, server_default="active"))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(), nullable=True))
    op.alter_column("users", "is_active", existing_type=sa.Boolean(), nullable=False, server_default="1")

    op.create_table(
        "user_preferences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False, server_default="cat"),
        sa.Column("quick_chat_enabled", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("bubble_frequency", sa.Integer(), nullable=False, server_default="120"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_user_preferences_user_id"),
    )
    op.create_index(op.f("ix_user_preferences_id"), "user_preferences", ["id"], unique=False)

    op.create_table(
        "verification_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=100), nullable=False),
        sa.Column("code", sa.String(length=6), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_verification_codes_email"), "verification_codes", ["email"], unique=False)
    op.create_index(op.f("ix_verification_codes_id"), "verification_codes", ["id"], unique=False)
    op.create_index(op.f("ix_verification_codes_purpose"), "verification_codes", ["purpose"], unique=False)

    op.add_column("documents", sa.Column("updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("documents", "updated_at")

    op.drop_index(op.f("ix_verification_codes_purpose"), table_name="verification_codes")
    op.drop_index(op.f("ix_verification_codes_id"), table_name="verification_codes")
    op.drop_index(op.f("ix_verification_codes_email"), table_name="verification_codes")
    op.drop_table("verification_codes")

    op.drop_index(op.f("ix_user_preferences_id"), table_name="user_preferences")
    op.drop_table("user_preferences")

    op.drop_column("users", "last_login_at")
    op.drop_column("users", "status")
