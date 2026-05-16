"""Initial onboarding schema

Revision ID: 001
Revises:
Create Date: 2026-05-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    op.create_table(
        "companies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(255), unique=True, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("industry", sa.String(255)),
        sa.Column("size", sa.String(50)),
        sa.Column("vision_statement", sa.Text),
        sa.Column("selected_models", postgresql.JSON),
        sa.Column("integrations", postgresql.JSON),
        sa.Column("onboarding_completed", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "onboarding_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), unique=True),
        sa.Column("current_step", sa.Integer, default=0),
        sa.Column("total_steps", sa.Integer, default=7),
        sa.Column("step_data", postgresql.JSON, default=dict),
        sa.Column("vision_raw", sa.Text),
        sa.Column("vision_analysis", postgresql.JSON),
        sa.Column("status", sa.String(50), default="in_progress"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "knowledge_graphs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), unique=True),
        sa.Column("nodes", postgresql.JSON),
        sa.Column("edges", postgresql.JSON),
        sa.Column("domains", postgresql.JSON),
        sa.Column("capabilities", postgresql.JSON),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "constitutions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), unique=True),
        sa.Column("mission", sa.Text),
        sa.Column("values", postgresql.JSON),
        sa.Column("principles", postgresql.JSON),
        sa.Column("governance", postgresql.JSON),
        sa.Column("operational_rules", postgresql.JSON),
        sa.Column("full_text", sa.Text),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "roadmaps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), unique=True),
        sa.Column("phases", postgresql.JSON),
        sa.Column("milestones", postgresql.JSON),
        sa.Column("timeline", postgresql.JSON),
        sa.Column("priorities", postgresql.JSON),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "architecture_plans",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), unique=True),
        sa.Column("tech_stack", postgresql.JSON),
        sa.Column("system_design", postgresql.JSON),
        sa.Column("data_models", postgresql.JSON),
        sa.Column("api_spec", postgresql.JSON),
        sa.Column("infrastructure", postgresql.JSON),
        sa.Column("full_text", sa.Text),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id")),
        sa.Column("title", sa.String(500)),
        sa.Column("description", sa.Text),
        sa.Column("status", sa.String(50), default="todo"),
        sa.Column("priority", sa.String(50), default="medium"),
        sa.Column("assignee_role", sa.String(100)),
        sa.Column("parent_task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tasks.id")),
        sa.Column("dependencies", postgresql.JSON),
        sa.Column("metadata", postgresql.JSON),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "workflows",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id")),
        sa.Column("name", sa.String(255)),
        sa.Column("description", sa.Text),
        sa.Column("trigger", postgresql.JSON),
        sa.Column("steps", postgresql.JSON),
        sa.Column("assigned_agents", postgresql.JSON),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )


def downgrade():
    op.drop_table("workflows")
    op.drop_table("tasks")
    op.drop_table("architecture_plans")
    op.drop_table("roadmaps")
    op.drop_table("constitutions")
    op.drop_table("knowledge_graphs")
    op.drop_table("onboarding_sessions")
    op.drop_table("companies")
