import pLimit from 'p-limit';
import type { AIProvider } from '../providers/provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ModelInfo,
} from '../types/provider.js';
import { RateLimitError } from '../types/ai-provider.js';

export interface RateLimiterConfig {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrentRequests?: number;
}

const DEFAULT_CONFIG: Required<RateLimiterConfig> = {
  requestsPerMinute: 60,
  tokensPerMinute: 200_000,
  concurrentRequests: 10,
};

export class RateLimitingProvider implements AIProvider {
  get info() { return this.inner.info; }

  private readonly config: Required<RateLimiterConfig>;
  private readonly concurrencyLimiter: ReturnType<typeof pLimit>;
  private requestTimestamps: number[] = [];
  private tokenUsageTimestamps: Array<{ time: number; tokens: number }> = [];

  constructor(
    private readonly inner: AIProvider,
    config: RateLimiterConfig = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.concurrencyLimiter = pLimit(this.config.concurrentRequests);
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    await this.acquireRequestSlot(request);
    return this.concurrencyLimiter(() => this.inner.complete(request)) as Promise<CompletionResponse>;
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    await this.acquireRequestSlot(request);
    yield* this.inner.completeStream(request);
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  resolveModel(model: string): string {
    return this.inner.resolveModel(model);
  }

  validateRequest(request: CompletionRequest): string | null {
    return this.inner.validateRequest(request);
  }

  private async acquireRequestSlot(request: CompletionRequest): Promise<void> {
    const now = Date.now();
    const windowMs = 60_000;

    this.requestTimestamps = this.requestTimestamps.filter((t) => t > now - windowMs);
    this.tokenUsageTimestamps = this.tokenUsageTimestamps.filter((t) => t.time > now - windowMs);

    if (this.requestTimestamps.length >= this.config.requestsPerMinute) {
      const oldestInWindow = this.requestTimestamps[0];
      const waitMs = oldestInWindow - (now - windowMs);
      throw new RateLimitError(
        `Rate limit exceeded: ${this.config.requestsPerMinute} requests/min`,
        this.inner.info.id,
        waitMs,
      );
    }

    // Estimate token usage (~4 chars per token)
    const estimatedInputTokens = request.messages.reduce(
      (sum, m) => sum + JSON.stringify(m.content).length / 4,
      0,
    );
    const estimatedTotal = estimatedInputTokens + (request.max_tokens ?? 4096);
    const currentTokenUsage = this.tokenUsageTimestamps.reduce((s, t) => s + t.tokens, 0);

    if (currentTokenUsage + estimatedTotal > this.config.tokensPerMinute) {
      const oldestInWindow = this.tokenUsageTimestamps[0];
      const waitMs = oldestInWindow ? oldestInWindow.time - (now - windowMs) : 60000;
      throw new RateLimitError(
        `Token rate limit exceeded: ${this.config.tokensPerMinute} tokens/min`,
        this.inner.info.id,
        waitMs,
      );
    }

    this.requestTimestamps.push(now);
    this.tokenUsageTimestamps.push({ time: now, tokens: estimatedTotal });
  }
}
