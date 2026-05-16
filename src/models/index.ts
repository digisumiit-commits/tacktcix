// ── Types ─────────────────────────────────────────────────────
export type {
  Message,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  TokenUsage,
  ProviderInfo,
  ProviderCapabilities,
  ModelInfo,
} from './types/provider.js';

export {
  ProviderError,
  RateLimitError,
  AuthenticationError,
} from './types/ai-provider.js';
export type { ModelPricing, UsageRecord, UsageStats } from './types/ai-provider.js';

// ── Provider interface ────────────────────────────────────────
export type { AIProvider } from './providers/provider.js';
export { BaseProvider } from './providers/interface.js';
export type { ProviderConfig } from './providers/interface.js';

// ── DeepSeek provider ─────────────────────────────────────────
export { DeepSeekProvider } from './providers/deepseek.js';

// ── Routing ───────────────────────────────────────────────────
export { ModelRouter } from './routing/router.js';

// ── Middleware ────────────────────────────────────────────────
export { RateLimitingProvider } from './middleware/rate-limiter.js';
export type { RateLimiterConfig } from './middleware/rate-limiter.js';

export { RetryProvider } from './middleware/retry.js';
export type { RetryConfig } from './middleware/retry.js';

export { UsageTrackingProvider } from './middleware/usage-tracker.js';
export type { UsageTrackerHooks } from './middleware/usage-tracker.js';

// ── Configuration ─────────────────────────────────────────────
export { ConfigManager, DEFAULT_CONFIG } from './config/config.js';
export type {
  AgentModelConfig,
  ProviderConnectionConfig,
  ModelRouterConfig,
  AIConfig,
} from './config/config.js';

// ── Billing ────────────────────────────────────────────────────
export { billingService } from './services/billing.service.js';
export { walletService } from './services/wallet.service.js';
export { usageService } from './services/usage.service.js';
export { analyticsService } from './services/analytics.service.js';
export { billingRouter } from './routes/billing.routes.js';
export { createServer } from './server.js';

// ── Pricing ────────────────────────────────────────────────────
export { DEFAULT_PRICING, getPricingForResource, calculateCredits } from './pricing.js';
export type { Pricing } from './pricing.js';

// ── Factory ───────────────────────────────────────────────────
import { ConfigManager } from './config/config.js';
import { ModelRouter } from './routing/router.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { RateLimitingProvider } from './middleware/rate-limiter.js';
import { RetryProvider } from './middleware/retry.js';
import { UsageTrackingProvider } from './middleware/usage-tracker.js';
import type { AIProvider } from './providers/provider.js';
import type { UsageTrackerHooks } from './middleware/usage-tracker.js';
import type { CompletionRequest, CompletionResponse, StreamChunk, ModelInfo } from './types/provider.js';
import type { UsageStats } from './types/ai-provider.js';
import type { AIConfig } from './config/config.js';

export interface AIProvidersOptions {
  config?: Partial<AIConfig>;
  usageHooks?: UsageTrackerHooks;
}

export interface AIProviders {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  completeStream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  getAvailableModels(): Promise<ModelInfo[]>;
  getStats(): UsageStats;
  getConfig(): Readonly<AIConfig>;
  configManager: ConfigManager;
  router: ModelRouter;
}

export function createAIProviders(options: AIProvidersOptions = {}): AIProviders {
  const configManager = new ConfigManager(options.config);

  // Register providers from config
  const providerConfigs = configManager.getConfig().providers;
  for (const [name, providerConfig] of Object.entries(providerConfigs)) {
    let provider: AIProvider;

    if (name === 'deepseek') {
      provider = new DeepSeekProvider(providerConfig);
    } else {
      // Generic OpenAI-compatible provider via DeepSeekProvider with custom baseUrl
      provider = new DeepSeekProvider({ ...providerConfig, baseUrl: providerConfig.baseUrl });
    }

    // Wrap in middleware stack
    const withTracking = new UsageTrackingProvider(provider, options.usageHooks);
    const withRateLimit = new RateLimitingProvider(withTracking, providerConfig.rateLimit);
    const withRetry = new RetryProvider(withRateLimit, {
      maxRetries: providerConfig.maxRetries,
    });

    configManager.registerProvider(name, withRetry);
  }

  // Default: register DeepSeek if no providers configured
  if (configManager.getRegisteredProviders().length === 0) {
    const provider = new DeepSeekProvider({
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    });
    const withTracking = new UsageTrackingProvider(provider, options.usageHooks);
    const withRateLimit = new RateLimitingProvider(withTracking);
    const withRetry = new RetryProvider(withRateLimit);
    configManager.registerProvider('deepseek', withRetry);
  }

  const router = new ModelRouter(configManager.getRouterConfig());
  for (const name of configManager.getRegisteredProviders()) {
    const p = configManager.getProvider(name);
    if (p) router.registerProvider(p);
  }

  // Pre-warm model mappings
  router.refreshModelMappings().catch(() => {});

  // Collect tracking providers for stats aggregation
  const trackedProviders = new Map<string, UsageTrackingProvider>();
  for (const name of configManager.getRegisteredProviders()) {
    const provider = configManager.getProvider(name);
    if (provider) {
      // Unwrap middleware layers: RetryProvider.inner -> RateLimitingProvider.inner -> UsageTrackingProvider
      const retry = provider as RetryProvider;
      const rateLimiter = (retry as unknown as { inner: AIProvider }).inner;
      if (rateLimiter) {
        const tracker = (rateLimiter as unknown as { inner: AIProvider }).inner;
        if (tracker instanceof UsageTrackingProvider) {
          trackedProviders.set(name, tracker);
        }
      }
    }
  }

  return {
    configManager,
    router,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      return router.complete(request);
    },

    async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
      const { provider, model } = await router.route(request);
      yield* provider.completeStream({ ...request, model });
    },

    async getAvailableModels(): Promise<ModelInfo[]> {
      return router.getAvailableModels();
    },

    getStats(): UsageStats {
      const stats: UsageStats = {
        totalRequests: 0,
        totalTokens: 0,
        totalCost: 0,
        averageLatencyMs: 0,
        byProvider: {},
        byModel: {},
      };
      for (const [, tracker] of trackedProviders) {
        const s = tracker.getStats();
        stats.totalRequests += s.totalRequests;
        stats.totalTokens += s.totalTokens;
        stats.totalCost += s.totalCost;
        for (const [k, v] of Object.entries(s.byProvider)) {
          const existing = stats.byProvider[k];
          if (existing) {
            existing.requests += v.requests;
            existing.tokens += v.tokens;
            existing.cost += v.cost;
          } else {
            stats.byProvider[k] = { ...v };
          }
        }
        for (const [k, v] of Object.entries(s.byModel)) {
          const existing = stats.byModel[k];
          if (existing) {
            existing.requests += v.requests;
            existing.tokens += v.tokens;
            existing.cost += v.cost;
          } else {
            stats.byModel[k] = { ...v };
          }
        }
      }
      return stats;
    },

    getConfig() {
      return configManager.getConfig();
    },
  };
}
