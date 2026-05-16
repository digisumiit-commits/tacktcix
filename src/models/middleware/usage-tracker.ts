import type { AIProvider } from '../providers/provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ModelInfo,
  TokenUsage,
} from '../types/provider.js';
import type { UsageRecord, UsageStats } from '../types/ai-provider.js';

export type { UsageRecord, UsageStats };

export interface UsageTrackerHooks {
  onComplete?: (record: UsageRecord) => void | Promise<void>;
  onStreamComplete?: (record: UsageRecord) => void | Promise<void>;
  onError?: (record: UsageRecord) => void | Promise<void>;
}

export class UsageTrackingProvider implements AIProvider {
  get info() { return this.innerProvider.info; }

  private readonly hooks: UsageTrackerHooks;
  private readonly records: UsageRecord[] = [];
  private readonly agentId?: string;

  // Expose inner for middleware chain unwrapping
  readonly innerProvider: AIProvider;

  constructor(
    inner: AIProvider,
    hooks: UsageTrackerHooks = {},
    agentId?: string,
  ) {
    this.innerProvider = inner;
    this.hooks = hooks;
    this.agentId = agentId;
  }

  async healthCheck(): Promise<boolean> {
    return this.innerProvider.healthCheck();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();
    const recordId = crypto.randomUUID();

    try {
      const response = await this.innerProvider.complete(request);
      const record = this.buildRecord(recordId, request, response.usage, Date.now() - start, true);
      this.records.push(record);
      await this.hooks.onComplete?.(record);
      return response;
    } catch (err) {
      const record = this.buildRecord(recordId, request, undefined, Date.now() - start, false, err);
      this.records.push(record);
      await this.hooks.onError?.(record);
      throw err;
    }
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const start = Date.now();
    const recordId = crypto.randomUUID();
    let totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    try {
      for await (const chunk of this.innerProvider.completeStream(request)) {
        // StreamChunk doesn't include usage, so we estimate
        totalUsage.total_tokens += 1;
        yield chunk;
      }

      const record = this.buildRecord(recordId, request, totalUsage, Date.now() - start, true);
      this.records.push(record);
      await this.hooks.onStreamComplete?.(record);
    } catch (err) {
      const record = this.buildRecord(recordId, request, undefined, Date.now() - start, false, err);
      this.records.push(record);
      await this.hooks.onError?.(record);
      throw err;
    }
  }

  listModels(): Promise<ModelInfo[]> {
    return this.innerProvider.listModels();
  }

  resolveModel(model: string): string {
    return this.innerProvider.resolveModel(model);
  }

  validateRequest(request: CompletionRequest): string | null {
    return this.innerProvider.validateRequest(request);
  }

  getStats(): UsageStats {
    const stats: UsageStats = {
      totalRequests: this.records.length,
      totalTokens: 0,
      totalCost: 0,
      averageLatencyMs: 0,
      byProvider: {},
      byModel: {},
    };

    let totalLatency = 0;
    let successCount = 0;

    for (const record of this.records) {
      stats.totalTokens += record.usage.totalTokens;
      stats.totalCost += record.usage.cost ?? 0;
      totalLatency += record.latencyMs;
      if (record.success) successCount++;

      const providerStats = stats.byProvider[record.provider] ??= {
        requests: 0, tokens: 0, cost: 0,
      };
      providerStats.requests++;
      providerStats.tokens += record.usage.totalTokens;
      providerStats.cost += record.usage.cost ?? 0;

      const modelStats = stats.byModel[record.model] ??= {
        requests: 0, tokens: 0, cost: 0,
      };
      modelStats.requests++;
      modelStats.tokens += record.usage.totalTokens;
      modelStats.cost += record.usage.cost ?? 0;
    }

    stats.averageLatencyMs = successCount > 0 ? totalLatency / successCount : 0;
    return stats;
  }

  getRecords(): UsageRecord[] {
    return [...this.records];
  }

  clearRecords(): void {
    this.records.length = 0;
  }

  private buildRecord(
    id: string,
    request: CompletionRequest,
    usage: TokenUsage | undefined,
    latencyMs: number,
    success: boolean,
    error?: unknown,
  ): UsageRecord {
    return {
      id,
      timestamp: Date.now(),
      provider: this.innerProvider.info.id,
      model: request.model,
      agentId: this.agentId,
      request: {
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        maxTokens: request.max_tokens,
      },
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
        cost: undefined,
      },
      latencyMs,
      success,
      error: error instanceof Error ? error.message : String(error ?? ''),
    };
  }
}
