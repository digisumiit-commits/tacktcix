-- TACKTCIX Memory System: PostgreSQL schema
-- 5 layers: founder, constitution, project, agent, episodic

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Primary memory table — all 5 layers with per-company isolation
CREATE TABLE memory_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    layer VARCHAR(32) NOT NULL CHECK (layer IN ('founder', 'constitution', 'project', 'agent', 'episodic')),
    entity_type VARCHAR(64) NOT NULL,
    title VARCHAR(512) NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    tags TEXT[] NOT NULL DEFAULT '{}',
    embedding_id VARCHAR(256),
    parent_id UUID REFERENCES memory_entries(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relationships between memory entries
CREATE TABLE memory_relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    source_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    relationship_type VARCHAR(64) NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    weight FLOAT NOT NULL DEFAULT 1.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for memory_entries
CREATE INDEX ix_memory_company_layer ON memory_entries (company_id, layer);
CREATE INDEX ix_memory_company_id ON memory_entries (company_id);
CREATE INDEX ix_memory_layer ON memory_entries (layer);
CREATE INDEX ix_memory_entity_type ON memory_entries (entity_type);
CREATE INDEX ix_memory_company_tags ON memory_entries USING GIN (company_id, tags);
CREATE INDEX ix_memory_embedding ON memory_entries (embedding_id);
CREATE INDEX ix_memory_expires ON memory_entries (expires_at);
CREATE INDEX ix_memory_parent ON memory_entries (parent_id);
CREATE INDEX ix_memory_content_trgm ON memory_entries USING GIN (to_tsvector('english', content));
CREATE INDEX ix_memory_title_trgm ON memory_entries USING GIN (to_tsvector('english', title));

-- Indexes for memory_relationships
CREATE INDEX ix_memrel_company ON memory_relationships (company_id);
CREATE INDEX ix_memrel_source ON memory_relationships (source_id);
CREATE INDEX ix_memrel_target ON memory_relationships (target_id);
CREATE INDEX ix_memrel_type ON memory_relationships (relationship_type);
CREATE INDEX ix_memrel_source_target ON memory_relationships (source_id, target_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_memory_entries_updated_at
    BEFORE UPDATE ON memory_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Episodic memory cleanup: remove expired entries
CREATE OR REPLACE FUNCTION cleanup_expired_episodic()
RETURNS void AS $$
BEGIN
    DELETE FROM memory_entries
    WHERE expires_at IS NOT NULL AND expires_at < NOW();
END;
$$ language 'plpgsql';
