"""add recurring reminder series

Revision ID: 010
Revises: 009
Create Date: 2026-07-31
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reminder_series",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("pet_type", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=True),
        sa.Column("recurrence_type", sa.String(length=20), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("local_hour", sa.Integer(), nullable=False),
        sa.Column("local_minute", sa.Integer(), nullable=False),
        sa.Column("weekdays", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), server_default="active", nullable=False),
        sa.Column("email_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("next_occurrence_at", sa.DateTime(), nullable=False),
        sa.Column("next_sequence", sa.Integer(), server_default="2", nullable=False),
        sa.Column("last_materialized_at", sa.DateTime(), nullable=True),
        sa.Column(
            "skipped_occurrence_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_reminder_series_id"), "reminder_series", ["id"], unique=False)
    op.create_index(
        op.f("ix_reminder_series_user_id"),
        "reminder_series",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_reminder_series_pet_type"),
        "reminder_series",
        ["pet_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_reminder_series_status"),
        "reminder_series",
        ["status"],
        unique=False,
    )
    op.create_index(
        op.f("ix_reminder_series_next_occurrence_at"),
        "reminder_series",
        ["next_occurrence_at"],
        unique=False,
    )
    op.create_index(
        "ix_reminder_series_materialization",
        "reminder_series",
        ["status", "next_occurrence_at"],
        unique=False,
    )

    op.add_column("reminders", sa.Column("series_id", sa.Integer(), nullable=True))
    op.add_column(
        "reminders",
        sa.Column(
            "recurrence_type",
            sa.String(length=20),
            server_default="once",
            nullable=False,
        ),
    )
    op.add_column(
        "reminders",
        sa.Column("cancellation_source", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "reminders",
        sa.Column("occurrence_sequence", sa.Integer(), nullable=True),
    )
    op.add_column(
        "reminders",
        sa.Column(
            "creation_source",
            sa.String(length=20),
            server_default="user",
            nullable=False,
        ),
    )
    op.create_foreign_key(
        "fk_reminders_series_id",
        "reminders",
        "reminder_series",
        ["series_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_reminders_series_id", "reminders", ["series_id"], unique=False)
    op.create_unique_constraint(
        "uq_reminders_series_sequence",
        "reminders",
        ["series_id", "occurrence_sequence"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_reminders_series_sequence",
        "reminders",
        type_="unique",
    )
    op.drop_index("ix_reminders_series_id", table_name="reminders")
    op.drop_constraint("fk_reminders_series_id", "reminders", type_="foreignkey")
    op.drop_column("reminders", "cancellation_source")
    op.drop_column("reminders", "creation_source")
    op.drop_column("reminders", "occurrence_sequence")
    op.drop_column("reminders", "recurrence_type")
    op.drop_column("reminders", "series_id")

    op.drop_index("ix_reminder_series_materialization", table_name="reminder_series")
    op.drop_index(
        op.f("ix_reminder_series_next_occurrence_at"),
        table_name="reminder_series",
    )
    op.drop_index(op.f("ix_reminder_series_status"), table_name="reminder_series")
    op.drop_index(op.f("ix_reminder_series_pet_type"), table_name="reminder_series")
    op.drop_index(op.f("ix_reminder_series_user_id"), table_name="reminder_series")
    op.drop_index(op.f("ix_reminder_series_id"), table_name="reminder_series")
    op.drop_table("reminder_series")
