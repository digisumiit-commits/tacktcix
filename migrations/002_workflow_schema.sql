-- TACKTCIX Workflow Engine: DAG definitions + execution state
-- Requires: uuid-ossp extension (from 001_memory_schema.sql)

-- Workflow definitions (versioned DAG blueprints)
CREATE TABLE workflow_definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    name VARCHAR(256) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    definition JSONB NOT NULL DEFAULT '{"steps":[],"edges":[],"metadata":{}}',
    status VARCHAR(32) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'completed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workflow execution runs
CREATE TABLE workflow_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
    company_id VARCHAR(36) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'timed_out', 'cancelled', 'paused')),
    context JSONB NOT NULL DEFAULT '{}',
    current_step_ids TEXT[] NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual step executions (one per attempt)
CREATE TABLE workflow_step_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    step_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'timed_out', 'cancelled', 'paused')),
    attempt INTEGER NOT NULL DEFAULT 0,
    input JSONB NOT NULL DEFAULT '{}',
    output JSONB NOT NULL DEFAULT '{}',
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for workflow_definitions
CREATE INDEX ix_wf_def_company ON workflow_definitions (company_id);
CREATE INDEX ix_wf_def_company_status ON workflow_definitions (company_id, status);
CREATE INDEX ix_wf_def_updated ON workflow_definitions (updated_at DESC);

-- Indexes for workflow_executions
CREATE INDEX ix_wf_exec_company ON workflow_executions (company_id);
CREATE INDEX ix_wf_exec_workflow ON workflow_executions (workflow_id);
CREATE INDEX ix_wf_exec_status ON workflow_executions (status);
CREATE INDEX ix_wf_exec_company_status ON workflow_executions (company_id, status);
CREATE INDEX ix_wf_exec_created ON workflow_executions (created_at DESC);

-- Indexes for workflow_step_executions
CREATE INDEX ix_wf_step_exec_execution ON workflow_step_executions (execution_id);
CREATE INDEX ix_wf_step_exec_status ON workflow_step_executions (status);

-- Auto-update updated_at triggers
CREATE TRIGGER update_wf_definitions_updated_at
    BEFORE UPDATE ON workflow_definitions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wf_executions_updated_at
    BEFORE UPDATE ON workflow_executions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wf_step_executions_updated_at
    BEFORE UPDATE ON workflow_step_executions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
