-- TACKTCIX Context Bus: pub/sub message persistence
-- Agents publish artifacts/decisions to topics; all messages are auditable.

-- Published bus messages (immutable after insert)
CREATE TABLE bus_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    topic VARCHAR(256) NOT NULL,
    sender_agent_id VARCHAR(128) NOT NULL,
    message_type VARCHAR(32) NOT NULL CHECK (message_type IN ('artifact', 'decision', 'event')),
    payload JSONB NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    correlation_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active topic subscriptions
CREATE TABLE bus_subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id VARCHAR(36) NOT NULL,
    agent_id VARCHAR(128) NOT NULL,
    topic_pattern VARCHAR(256) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, agent_id, topic_pattern)
);

-- Delivery tracking for at-least-once semantics
CREATE TABLE bus_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID NOT NULL REFERENCES bus_messages(id) ON DELETE CASCADE,
    subscriber_agent_id VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, subscriber_agent_id)
);

-- Indexes
CREATE INDEX ix_bus_messages_company_topic ON bus_messages (company_id, topic);
CREATE INDEX ix_bus_messages_company_created ON bus_messages (company_id, created_at DESC);
CREATE INDEX ix_bus_messages_sender ON bus_messages (sender_agent_id);
CREATE INDEX ix_bus_messages_type ON bus_messages (message_type);
CREATE INDEX ix_bus_messages_correlation ON bus_messages (correlation_id);
CREATE INDEX ix_bus_messages_topic ON bus_messages (topic);
CREATE INDEX ix_bus_subscriptions_agent ON bus_subscriptions (company_id, agent_id);
CREATE INDEX ix_bus_subscriptions_topic ON bus_subscriptions (company_id, topic_pattern);
CREATE INDEX ix_bus_deliveries_message ON bus_deliveries (message_id);
CREATE INDEX ix_bus_deliveries_subscriber ON bus_deliveries (subscriber_agent_id);
CREATE INDEX ix_bus_deliveries_status ON bus_deliveries (status);
