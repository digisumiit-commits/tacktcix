import { BaseProvider, type ProviderConfig } from './interface.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderInfo,
  ModelInfo,
  TokenUsage,
  Message,
} from '../types/provider.js';
import { RateLimitError, AuthenticationError, ProviderError } from '../types/ai-provider.js';
import type { ModelPricing } from '../types/ai-provider.js';

export interface ModelEntry {
  maxTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  pricing: ModelPricing;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  name: string;
  models: Record<string, ModelEntry>;
  defaultModel: string;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export abstract class OpenAICompatibleProvider extends BaseProvider {
  abstract readonly info: ProviderInfo;

  protected readonly baseUrl: string;
  protected readonly modelData: Record<string, ModelEntry>;
  protected defaultModelId: string;

  constructor(config: ProviderConfig & { baseUrl: string }) {
    super(config);
    this.baseUrl = config.baseUrl;
    this.modelData = {};
    this.defaultModelId = '';
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/models`,
        { method: 'GET', headers: this.buildHeaders() },
      );
      if (response.status === 401) return false;
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.entries(this.modelData).map(([id, data]) => ({
      id,
      providerId: this.info.id,
      maxTokens: data.maxTokens,
      supportsStreaming: data.supportsStreaming,
      supportsTools: data.supportsTools,
      supportsVision: data.supportsVision,
    }));
  }

  override resolveModel(model: string): string {
    if (this.modelData[model]) return model;
    return this.defaultModelId;
  }

  override validateRequest(request: CompletionRequest): string | null {
    const modelData = this.modelData[request.model];
    if (!modelData) return `Unknown model: ${request.model}`;
    if (request.tools && !modelData.supportsTools) {
      return `Model ${request.model} does not support tools`;
    }
    return null;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false);
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    await this.handleErrorResponse(response);

    const data = await response.json() as Record<string, unknown>;
    return this.parseResponse(data);
  }

  async *completeStream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request, true);
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      },
    );

    await this.handleErrorResponse(response);

    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('No response body', this.info.id);

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            yield this.parseChunk(parsed);
          } catch {
            // Skip unparseable chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  computeCost(model: string, usage: TokenUsage): number | undefined {
    const entry = this.modelData[model];
    if (!entry) return undefined;
    return (
      (usage.prompt_tokens / 1000) * entry.pricing.inputCostPer1K +
      (usage.completion_tokens / 1000) * entry.pricing.outputCostPer1K
    );
  }

  getPricing(model: string): ModelPricing | undefined {
    return this.modelData[model]?.pricing;
  }

  // ── Protected helpers ────────────────────────────────────

  protected buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      })),
      stream,
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.max_tokens != null ? { max_tokens: request.max_tokens } : {}),
      ...(request.top_p != null ? { top_p: request.top_p } : {}),
      ...(request.stop ? { stop: request.stop } : {}),
      ...(request.tools ? { tools: request.tools } : {}),
    };
  }

  protected async handleErrorResponse(response: Response): Promise<void> {
    if (response.ok) return;

    const providerId = this.info.id;

    if (response.status === 401) {
      throw new AuthenticationError(providerId);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new RateLimitError(
        `Rate limited by ${providerId}`,
        providerId,
        retryAfter ? parseInt(retryAfter) * 1000 : undefined,
      );
    }

    let errorMessage = `${providerId} API error: ${response.status}`;
    try {
      const body = await response.json() as Record<string, unknown>;
      if (body.error && typeof body.error === 'object') {
        const err = body.error as Record<string, unknown>;
        errorMessage = String(err.message ?? errorMessage);
      }
    } catch {
      // Use default message
    }

    const retryable = response.status >= 500 || response.status === 503;
    throw new ProviderError(errorMessage, providerId, response.status, retryable);
  }

  protected parseResponse(data: Record<string, unknown>): CompletionResponse {
    const id = String(data.id ?? crypto.randomUUID());
    const model = String(data.model ?? 'unknown');
    const created = Number(data.created ?? Date.now());

    const choices: CompletionResponse['choices'] = [];
    const rawChoices = data.choices as Array<Record<string, unknown>> | undefined;
    if (rawChoices) {
      for (const raw of rawChoices) {
        const msg = raw.message as Record<string, unknown> | undefined;
        choices.push({
          index: Number(raw.index ?? 0),
          message: {
            role: (msg?.role as Message['role']) ?? 'assistant',
            content: (msg?.content ?? '') as string,
            ...(msg?.tool_calls ? { tool_calls: msg.tool_calls as Message['tool_calls'] } : {}),
          },
          finish_reason: raw.finish_reason as CompletionResponse['choices'][0]['finish_reason'] ?? null,
        });
      }
    }

    const rawUsage = data.usage as Record<string, number> | undefined;
    const usage: TokenUsage | undefined = rawUsage ? {
      prompt_tokens: rawUsage.prompt_tokens ?? 0,
      completion_tokens: rawUsage.completion_tokens ?? 0,
      total_tokens: rawUsage.total_tokens ?? 0,
    } : undefined;

    return { id, model, provider: this.info.id, choices, usage, created };
  }

  protected parseChunk(data: Record<string, unknown>): StreamChunk {
    const id = String(data.id ?? crypto.randomUUID());
    const model = String(data.model ?? 'unknown');
    const created = Number(data.created ?? Date.now());

    const choices: StreamChunk['choices'] = [];
    const rawChoices = data.choices as Array<Record<string, unknown>> | undefined;
    if (rawChoices) {
      for (const raw of rawChoices) {
        const delta = raw.delta as Record<string, unknown> | undefined;
        choices.push({
          index: Number(raw.index ?? 0),
          delta: {
            ...(delta?.role ? { role: String(delta.role) } : {}),
            ...(delta?.content != null ? { content: String(delta.content) } : {}),
            ...(delta?.tool_calls ? { tool_calls: delta.tool_calls as StreamChunk['choices'][0]['delta']['tool_calls'] } : {}),
          },
          finish_reason: (raw.finish_reason as string) ?? undefined,
        });
      }
    }

    return { id, model, provider: this.info.id, choices };
  }
}
