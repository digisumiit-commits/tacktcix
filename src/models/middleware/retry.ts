import type { AIProvider } from '../providers/provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ModelInfo,
} from '../types/provider.js';
import { ProviderError } from '../types/ai-provider.js';

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

export class RetryProvider implements AIProvider {
  get info() { return this.inner.info; }

  private readonly config: Required<RetryConfig>;

  constructor(
    private readonly inner: AIProvider,
    config: RetryConfig = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.executeWithRetry(() => this.inner.complete(request));
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        yield* this.inner.completeStream(request);
        return;
      } catch (err) {
        lastError = err as Error;
        if (!this.isRetryable(err) || attempt === this.config.maxRetries) break;
        await this.delay(attempt);
      }
    }

    throw lastError;
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

  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (!this.isRetryable(err) || attempt === this.config.maxRetries) break;
        await this.delay(attempt);
      }
    }

    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof ProviderError && error.retryable) return true;
    if (error instanceof TypeError && error.message.includes('fetch')) return true;
    return false;
  }

  private delay(attempt: number): Promise<void> {
    const baseDelay = this.config.initialDelayMs * Math.pow(this.config.backoffMultiplier, attempt);
    const jitter = Math.random() * 0.3 * baseDelay;
    const waitMs = Math.min(baseDelay + jitter, this.config.maxDelayMs);
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
