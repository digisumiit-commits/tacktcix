-- TACKTCIX Marketing Agent: content, campaign, and analytics storage
-- Requires: uuid-ossp extension (from 001_memory_schema.sql)

-- Marketing content assets (blog posts, social media, emails, etc.)
CREATE TABLE marketing_content (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
    content_type VARCHAR(32) NOT NULL
        CHECK (content_type IN ('blog_post', 'social_media', 'email', 'landing_page', 'ad_copy', 'newsletter', 'press_release')),
    title VARCHAR(512) NOT NULL,
    body TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    tags TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(32) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'review', 'approved', 'published', 'archived')),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Marketing campaigns
CREATE TABLE marketing_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    name VARCHAR(256) NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    channels TEXT[] NOT NULL DEFAULT '{}',
    budget NUMERIC(12, 2) NOT NULL DEFAULT 0,
    spent NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    goals JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_by VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaign performance metrics
CREATE TABLE marketing_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    campaign_id UUID NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
    metric VARCHAR(32) NOT NULL
        CHECK (metric IN ('impressions', 'clicks', 'conversions', 'revenue', 'spend', 'engagement', 'reach', 'bounce_rate', 'ctr', 'roi')),
    value NUMERIC(14, 4) NOT NULL,
    dimension VARCHAR(64) NOT NULL DEFAULT 'overall',
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for marketing_content
CREATE INDEX ix_mkt_content_company ON marketing_content (company_id);
CREATE INDEX ix_mkt_content_type ON marketing_content (company_id, content_type);
CREATE INDEX ix_mkt_content_status ON marketing_content (company_id, status);
CREATE INDEX ix_mkt_content_campaign ON marketing_content (campaign_id);
CREATE INDEX ix_mkt_content_created ON marketing_content (created_at DESC);

-- Indexes for marketing_campaigns
CREATE INDEX ix_mkt_campaigns_company ON marketing_campaigns (company_id);
CREATE INDEX ix_mkt_campaigns_status ON marketing_campaigns (company_id, status);
CREATE INDEX ix_mkt_campaigns_created ON marketing_campaigns (created_at DESC);

-- Indexes for marketing_metrics
CREATE INDEX ix_mkt_metrics_campaign ON marketing_metrics (campaign_id);
CREATE INDEX ix_mkt_metrics_type ON marketing_metrics (campaign_id, metric);
CREATE INDEX ix_mkt_metrics_recorded ON marketing_metrics (recorded_at DESC);

-- Auto-update updated_at triggers
CREATE TRIGGER update_mkt_content_updated_at
    BEFORE UPDATE ON marketing_content
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_mkt_campaigns_updated_at
    BEFORE UPDATE ON marketing_campaigns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
