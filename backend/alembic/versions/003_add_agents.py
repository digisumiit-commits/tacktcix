"""Add agents table for agent registry

Revision ID: 003_add_agents
Revises: 002_add_activity_events
Create Date: 2026-05-16
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "003_add_agents"
down_revision: Union[str, None] = "002_add_activity_events"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("role", sa.String(100), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.String(1000)),
        sa.Column("status", sa.String(50), server_default="idle"),
        sa.Column("capabilities", postgresql.JSON),
        sa.Column("cost_per_task", sa.Float, server_default="1.0"),
        sa.Column("max_concurrent_tasks", sa.Integer, server_default="3"),
        sa.Column("current_load", sa.Integer, server_default="0"),
        sa.Column("metadata", postgresql.JSON),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("agents")
