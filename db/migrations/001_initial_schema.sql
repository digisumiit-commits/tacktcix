-- TACKTCIX Platform — Multi-tenant schema with row-level security
-- Each company is isolated via RLS policies on the company_id column.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Companies ──────────────────────────────────────────

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Users ──────────────────────────────────────────────

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id),
    email VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, email)
);

-- ── Projects ───────────────────────────────────────────

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id),
    name VARCHAR(255) NOT NULL,
    key VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, key)
);

-- ── API Keys ───────────────────────────────────────────

CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id),
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    scopes VARCHAR(512) NOT NULL DEFAULT 'read',
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────

CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_projects_company ON projects(company_id);
CREATE INDEX idx_api_keys_company ON api_keys(company_id);

-- ── Enable Row-Level Security ──────────────────────────
-- Each tenant can only see rows where company_id matches their claim.

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Helper: extract the current tenant's company_id from the runtime config.
-- In production, SET LOCAL tacktcix.company_id is called at session start
-- by the multi-tenant middleware after resolving the tenant from the request.

CREATE OR REPLACE FUNCTION current_company_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('tacktcix.company_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Company RLS: a company can see itself
CREATE POLICY company_isolation ON companies
    FOR ALL
    USING (id = current_company_id())
    WITH CHECK (id = current_company_id());

-- User RLS
CREATE POLICY user_isolation ON users
    FOR ALL
    USING (company_id = current_company_id())
    WITH CHECK (company_id = current_company_id());

-- Project RLS
CREATE POLICY project_isolation ON projects
    FOR ALL
    USING (company_id = current_company_id())
    WITH CHECK (company_id = current_company_id());

-- API Key RLS
CREATE POLICY apikey_isolation ON api_keys
    FOR ALL
    USING (company_id = current_company_id())
    WITH CHECK (company_id = current_company_id());

-- ── updated_at trigger ─────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
