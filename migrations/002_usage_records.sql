-- TACKTCIX Memory System: Usage tracking schema
-- Tracks LLM API usage per company with periodic flush from in-memory buffer

CREATE TABLE usage_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    agent_id VARCHAR(128),
    model VARCHAR(128),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
    cost NUMERIC(12,8),
    endpoint VARCHAR(256),
    metadata JSONB NOT NULL DEFAULT '{}',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX ix_usage_records_company ON usage_records (company_id);
CREATE INDEX ix_usage_records_company_recorded ON usage_records (company_id, recorded_at DESC);
CREATE INDEX ix_usage_records_agent ON usage_records (agent_id);
CREATE INDEX ix_usage_records_model ON usage_records (model);
CREATE INDEX ix_usage_records_recorded ON usage_records (recorded_at);
