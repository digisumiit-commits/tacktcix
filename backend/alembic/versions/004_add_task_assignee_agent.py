"""Add assignee_agent_id to tasks table.

Revision ID: 004_add_task_assignee_agent
Revises: 003_add_agents
Create Date: 2026-05-16
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "004_add_task_assignee_agent"
down_revision: Union[str, None] = "003_add_agents"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    op.add_column(
        "tasks",
        sa.Column("assignee_agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("agents.id"), nullable=True),
    )
    op.create_index(op.f("ix_tasks_assignee_agent_id"), "tasks", ["assignee_agent_id"])


def downgrade():
    op.drop_index(op.f("ix_tasks_assignee_agent_id"), table_name="tasks")
    op.drop_column("tasks", "assignee_agent_id")
