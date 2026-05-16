// ── Error types ───────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    provider: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message, provider, 429, true);
    this.name = 'RateLimitError';
  }
}

export class AuthenticationError extends ProviderError {
  constructor(provider: string) {
    super(`Authentication failed for ${provider}`, provider, 401, false);
    this.name = 'AuthenticationError';
  }
}

// ── Pricing ───────────────────────────────────────────────────

export interface ModelPricing {
  inputCostPer1K: number;
  outputCostPer1K: number;
  currency: string;
}

// ── Usage tracking ────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  agentId?: string;
  request: {
    messageCount: number;
    toolCount: number;
    maxTokens?: number;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
  };
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number;
  byProvider: Record<string, { requests: number; tokens: number; cost: number }>;
  byModel: Record<string, { requests: number; tokens: number; cost: number }>;
}
