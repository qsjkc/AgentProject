"""add weekly retention funnel query index

Revision ID: 013
Revises: 012
Create Date: 2026-08-11
"""

from typing import Sequence, Union

from alembic import op


revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_pet_retention_events_weekly_funnel",
        "pet_retention_events",
        ["pet_type", "review_key", "event_type", "user_id"],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_pet_retention_events_weekly_funnel",
        table_name="pet_retention_events",
        if_exists=True,
    )
