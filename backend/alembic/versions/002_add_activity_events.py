"""Add activity_events table for real-time activity feed."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSON

revision = "002_add_activity_events"
down_revision = "001_initial_onboarding"


def upgrade():
    op.create_table(
        "activity_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("company_id", UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=False, index=True),
        sa.Column("type", sa.String(50), nullable=False, index=True),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("source_id", sa.String(255), nullable=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("metadata", JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("now()"), index=True),
    )
    op.create_index(
        "ix_activity_events_company_created",
        "activity_events",
        ["company_id", sa.text("created_at DESC")],
    )


def downgrade():
    op.drop_index("ix_activity_events_company_created", table_name="activity_events")
    op.drop_table("activity_events")
