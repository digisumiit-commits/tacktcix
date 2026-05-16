-- Migration: 002_task_orchestration.sql
-- Task orchestration engine tables

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(512) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(32) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','planning','executing','blocked','review','approved','deployed','failed')),
    priority VARCHAR(32) NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('critical','high','medium','low')),
    assignee_id UUID,
    parent_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tasks_status_priority ON tasks(status, priority DESC, created_at ASC);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX idx_dependencies_task ON task_dependencies(task_id);
CREATE INDEX idx_dependencies_depends ON task_dependencies(depends_on_task_id);

CREATE TABLE task_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    level VARCHAR(16) NOT NULL DEFAULT 'info'
        CHECK (level IN ('info','warn','error','debug')),
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_logs_task ON task_logs(task_id, created_at DESC);

CREATE TRIGGER update_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Circular dependency guard
CREATE OR REPLACE FUNCTION check_circular_dependency()
RETURNS TRIGGER AS $$
DECLARE
    cycle_exists BOOLEAN;
BEGIN
    WITH RECURSIVE dep_chain AS (
        SELECT NEW.depends_on_task_id AS id
        UNION ALL
        SELECT td.depends_on_task_id
        FROM task_dependencies td
        INNER JOIN dep_chain dc ON td.task_id = dc.id
    )
    SELECT EXISTS (SELECT 1 FROM dep_chain WHERE id = NEW.task_id) INTO cycle_exists;

    IF cycle_exists THEN
        RAISE EXCEPTION 'circular dependency detected: task % cannot depend on task %', NEW.task_id, NEW.depends_on_task_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_circular_dependency_trigger
    BEFORE INSERT ON task_dependencies
    FOR EACH ROW EXECUTE FUNCTION check_circular_dependency();
