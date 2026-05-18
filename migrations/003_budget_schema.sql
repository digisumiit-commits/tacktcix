-- TACKTCIX Memory System: Budget management schema
-- Per-agent and per-workflow budget caps with spend tracking,
-- threshold alerts (80%, 100%), and auto-pause support.
--
-- Requires: uuid-ossp extension and usage_records table (from 002_usage_records.sql)

-- ── Budget Caps ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_caps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    scope VARCHAR(32) NOT NULL CHECK (scope IN ('agent', 'workflow', 'company')),
    scope_id VARCHAR(128) NOT NULL,
    monthly_cents INTEGER NOT NULL CHECK (monthly_cents >= 0),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    alert_thresholds INTEGER[] NOT NULL DEFAULT '{80,100}',
    notify_agent_ids TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_budget_caps_company ON budget_caps (company_id);
CREATE INDEX ix_budget_caps_scope ON budget_caps (company_id, scope);
CREATE UNIQUE INDEX uq_budget_caps_scope ON budget_caps (company_id, scope, scope_id);

-- ── Budget States ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_states (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_cap_id UUID NOT NULL REFERENCES budget_caps(id) ON DELETE CASCADE,
    company_id VARCHAR(36) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    spent_cents INTEGER NOT NULL DEFAULT 0,
    last_alerted_at JSONB NOT NULL DEFAULT '{}',
    paused_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_budget_states_cap ON budget_states (budget_cap_id);
CREATE INDEX ix_budget_states_company ON budget_states (company_id);
CREATE UNIQUE INDEX uq_budget_states_period ON budget_states (budget_cap_id, period_start);

-- ── Budget Alerts ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_cap_id UUID NOT NULL REFERENCES budget_caps(id) ON DELETE CASCADE,
    company_id VARCHAR(36) NOT NULL,
    threshold INTEGER NOT NULL,
    spent_cents INTEGER NOT NULL,
    monthly_cents INTEGER NOT NULL,
    usage_pct NUMERIC(6,2) NOT NULL,
    action VARCHAR(16) NOT NULL CHECK (action IN ('alert', 'paused')),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_budget_alerts_cap ON budget_alerts (budget_cap_id);
CREATE INDEX ix_budget_alerts_company ON budget_alerts (company_id);
CREATE INDEX ix_budget_alerts_sent ON budget_alerts (sent_at DESC);
