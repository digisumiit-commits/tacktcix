import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeepSeekProvider,
  ModelRouter,
  RateLimitingProvider,
  RetryProvider,
  UsageTrackingProvider,
  ConfigManager,
  createAIProviders,
  ProviderError,
  RateLimitError,
  AuthenticationError,
} from '../src/index.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ModelInfo,
  TokenUsage,
} from '../src/types/provider.js';

// ── Helpers ───────────────────────────────────────────────────

function mockFetch(responseInit: ResponseInit & { data?: unknown }) {
  const { data, ...init } = responseInit;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.status ? init.status < 400 : true,
    status: init.status ?? 200,
    headers: new Headers(init.headers),
    json: async () => data ?? {},
    body: null,
  } as Response);
}

function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...overrides };
}

function makeCompletionResponse(overrides?: Partial<CompletionResponse>): CompletionResponse {
  return {
    id: 'resp-1',
    model: 'deepseek-chat',
    provider: 'deepseek',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    }],
    usage: makeUsage(),
    created: Date.now(),
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hi' }],
    ...overrides,
  };
}

// ── Types ─────────────────────────────────────────────────────

describe('types', () => {
  it('ProviderError is retryable when specified', () => {
    const err = new ProviderError('test', 'deepseek', 500, true);
    expect(err.retryable).toBe(true);
    expect(err.provider).toBe('deepseek');
    expect(err.statusCode).toBe(500);
  });

  it('RateLimitError is always retryable', () => {
    const err = new RateLimitError('rate limited', 'deepseek', 5000);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('AuthenticationError is never retryable', () => {
    const err = new AuthenticationError('deepseek');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(401);
  });
});

// ── DeepSeek Provider ─────────────────────────────────────────

describe('DeepSeekProvider', () => {
  let provider: DeepSeekProvider;

  beforeEach(() => {
    provider = new DeepSeekProvider({ apiKey: 'test-key' });
    vi.restoreAllMocks();
  });

  it('has correct provider info', () => {
    expect(provider.info.id).toBe('deepseek');
    expect(provider.info.name).toBe('DeepSeek');
    expect(provider.info.supportsStreaming).toBe(true);
    expect(provider.info.supportsTools).toBe(true);
    expect(provider.info.defaultModel).toBe('deepseek-chat');
  });

  it('listModels returns DeepSeek models', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.find((m) => m.id === 'deepseek-chat')).toBeDefined();
    expect(models.find((m) => m.id === 'deepseek-reasoner')).toBeDefined();

    for (const model of models) {
      expect(model.providerId).toBe('deepseek');
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });

  it('healthCheck returns true on 200', async () => {
    mockFetch({ status: 200, data: { data: [] } });
    const valid = await provider.healthCheck();
    expect(valid).toBe(true);
  });

  it('healthCheck returns false on 401', async () => {
    mockFetch({ status: 401 });
    const valid = await provider.healthCheck();
    expect(valid).toBe(false);
  });

  it('complete sends request and parses response', async () => {
    const rawResponse = {
      id: 'resp-1',
      model: 'deepseek-chat',
      created: 1700000000,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    mockFetch({ status: 200, data: rawResponse });

    const response = await provider.complete(makeRequest());
    expect(response.id).toBe('resp-1');
    expect(response.model).toBe('deepseek-chat');
    expect(response.provider).toBe('deepseek');
    expect(response.choices[0].message.content).toBe('Hello!');
    expect(response.usage?.prompt_tokens).toBe(10);
    expect(response.usage?.completion_tokens).toBe(5);
    expect(response.usage?.total_tokens).toBe(15);
  });

  it('complete throws AuthenticationError on 401', async () => {
    mockFetch({ status: 401, data: { error: { message: 'Invalid API key' } } });
    await expect(provider.complete(makeRequest())).rejects.toThrow(AuthenticationError);
  });

  it('complete throws RateLimitError on 429', async () => {
    mockFetch({ status: 429, headers: { 'Retry-After': '5' } });
    await expect(provider.complete(makeRequest())).rejects.toThrow(RateLimitError);
  });

  it('computeCost returns correct cost', () => {
    const cost = provider.computeCost('deepseek-chat', makeUsage({ prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 }));
    expect(cost).toBeCloseTo(0.00027 + 0.0011, 5);
  });

  it('resolveModel maps aliases', () => {
    expect(provider.resolveModel('deepseek-r1')).toBe('deepseek-reasoner');
    expect(provider.resolveModel('deepseek')).toBe('deepseek-chat');
    expect(provider.resolveModel('unknown')).toBe('deepseek-chat');
  });
});

describe('DeepSeekProvider streaming', () => {
  let provider: DeepSeekProvider;

  beforeEach(() => {
    provider = new DeepSeekProvider({ apiKey: 'test-key' });
    vi.restoreAllMocks();
  });

  it('completeStream yields chunks', async () => {
    const chunks = [
      'data: {"id":"r1","model":"deepseek-chat","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n',
      'data: {"id":"r1","model":"deepseek-chat","created":1,"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      'data: {"id":"r1","model":"deepseek-chat","created":1,"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
      json: async () => ({}),
    } as Response);

    const results: StreamChunk[] = [];
    for await (const chunk of provider.completeStream({ ...makeRequest(), stream: true })) {
      results.push(chunk);
    }

    expect(results.length).toBe(3);
    expect(results[0].choices[0].delta.role).toBe('assistant');
    expect(results[1].choices[0].delta.content).toBe('Hello');
    expect(results[2].choices[0].delta.content).toBe(' world');
    expect(results[2].choices[0].finish_reason).toBe('stop');
  });
});

// ── Model Router ──────────────────────────────────────────────

describe('ModelRouter', () => {
  let router: ModelRouter;
  let mockProvider: {
    info: { id: string; name: string; models: string[]; defaultModel: string; supportsStreaming: boolean; supportsTools: boolean; supportsVision: boolean; maxTokens: Record<string, number> };
    complete: ReturnType<typeof vi.fn>;
    completeStream: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    resolveModel: ReturnType<typeof vi.fn>;
    validateRequest: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    router = new ModelRouter({ defaultProvider: 'mock' });
    mockProvider = {
      info: {
        id: 'mock',
        name: 'Mock Provider',
        models: ['mock-model'],
        defaultModel: 'mock-model',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        maxTokens: { 'mock-model': 4096 },
      },
      complete: vi.fn().mockResolvedValue(makeCompletionResponse({ provider: 'mock' })),
      completeStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue([
        {
          id: 'mock-model',
          providerId: 'mock',
          maxTokens: 4096,
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: false,
        },
      ]),
      healthCheck: vi.fn().mockResolvedValue(true),
      resolveModel: vi.fn().mockImplementation((m: string) => m),
      validateRequest: vi.fn().mockReturnValue(null),
    };

    // @ts-expect-error - partial mock
    router.registerProvider(mockProvider, ['mock-model']);
  });

  it('routes to registered provider by model name', async () => {
    const { provider, model } = await router.route(makeRequest({ model: 'mock-model' }));
    expect(provider).toBe(mockProvider);
    expect(model).toBe('mock-model');
  });

  it('falls back to default provider for unknown model', async () => {
    const { provider } = await router.route(makeRequest({ model: 'unknown-model' }));
    expect(provider).toBe(mockProvider);
  });

  it('throws when no fallback available and provider unhealthy', async () => {
    mockProvider.healthCheck.mockResolvedValue(false);
    await expect(
      router.route(makeRequest({ model: 'unknown-model' })),
    ).rejects.toThrow(ProviderError);
  });

  it('returns available models from all providers', async () => {
    const models = await router.getAvailableModels();
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(models[0].id).toBe('mock-model');
  });
});

// ── Rate Limiter ──────────────────────────────────────────────

describe('RateLimitingProvider', () => {
  let inner: {
    info: { id: string; name: string; models: string[]; defaultModel: string; supportsStreaming: boolean; supportsTools: boolean; supportsVision: boolean; maxTokens: Record<string, number> };
    complete: ReturnType<typeof vi.fn>;
    completeStream: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    resolveModel: ReturnType<typeof vi.fn>;
    validateRequest: ReturnType<typeof vi.fn>;
  };
  let limiter: RateLimitingProvider;

  beforeEach(() => {
    inner = {
      info: {
        id: 'deepseek',
        name: 'DeepSeek',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        maxTokens: { 'deepseek-chat': 8192 },
      },
      complete: vi.fn().mockResolvedValue(makeCompletionResponse()),
      completeStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue(true),
      resolveModel: vi.fn().mockImplementation((m: string) => m),
      validateRequest: vi.fn().mockReturnValue(null),
    };
    // @ts-expect-error - partial mock
    limiter = new RateLimitingProvider(inner, {
      requestsPerMinute: 100, // generous so test doesn't hit limit
      concurrentRequests: 10,
    });
  });

  it('allows requests within limits', async () => {
    const response = await limiter.complete(makeRequest());
    expect(response.provider).toBe('deepseek');
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('delegates listModels to inner', async () => {
    await limiter.listModels();
    expect(inner.listModels).toHaveBeenCalled();
  });

  it('delegates info to inner', () => {
    expect(limiter.info.id).toBe('deepseek');
  });
});

// ── Retry ─────────────────────────────────────────────────────

describe('RetryProvider', () => {
  let inner: {
    info: { id: string; name: string; models: string[]; defaultModel: string; supportsStreaming: boolean; supportsTools: boolean; supportsVision: boolean; maxTokens: Record<string, number> };
    complete: ReturnType<typeof vi.fn>;
    completeStream: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    resolveModel: ReturnType<typeof vi.fn>;
    validateRequest: ReturnType<typeof vi.fn>;
  };
  let retrier: RetryProvider;

  beforeEach(() => {
    inner = {
      info: {
        id: 'deepseek',
        name: 'DeepSeek',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        maxTokens: { 'deepseek-chat': 8192 },
      },
      complete: vi.fn(),
      completeStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue(true),
      resolveModel: vi.fn().mockImplementation((m: string) => m),
      validateRequest: vi.fn().mockReturnValue(null),
    };
    // @ts-expect-error - partial mock
    retrier = new RetryProvider(inner, { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 100 });
  });

  it('returns result on success without retrying', async () => {
    inner.complete.mockResolvedValueOnce(makeCompletionResponse());
    const response = await retrier.complete(makeRequest());
    expect(response.provider).toBe('deepseek');
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable ProviderError', async () => {
    inner.complete
      .mockRejectedValueOnce(new ProviderError('Server error', 'deepseek', 500, true))
      .mockResolvedValueOnce(makeCompletionResponse());

    const response = await retrier.complete(makeRequest());
    expect(response.provider).toBe('deepseek');
    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable error', async () => {
    inner.complete.mockRejectedValueOnce(new AuthenticationError('deepseek'));

    await expect(retrier.complete(makeRequest())).rejects.toThrow(AuthenticationError);
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('delegates info to inner', () => {
    expect(retrier.info.id).toBe('deepseek');
  });
});

// ── Usage Tracker ─────────────────────────────────────────────

describe('UsageTrackingProvider', () => {
  let inner: {
    info: { id: string; name: string; models: string[]; defaultModel: string; supportsStreaming: boolean; supportsTools: boolean; supportsVision: boolean; maxTokens: Record<string, number> };
    complete: ReturnType<typeof vi.fn>;
    completeStream: ReturnType<typeof vi.fn>;
    listModels: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
    resolveModel: ReturnType<typeof vi.fn>;
    validateRequest: ReturnType<typeof vi.fn>;
  };
  let tracker: UsageTrackingProvider;

  beforeEach(() => {
    inner = {
      info: {
        id: 'deepseek',
        name: 'DeepSeek',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
        maxTokens: { 'deepseek-chat': 8192 },
      },
      complete: vi.fn().mockResolvedValue(makeCompletionResponse()),
      completeStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue(true),
      resolveModel: vi.fn().mockImplementation((m: string) => m),
      validateRequest: vi.fn().mockReturnValue(null),
    };
    // @ts-expect-error - partial mock
    tracker = new UsageTrackingProvider(inner, {}, 'agent-1');
  });

  it('tracks successful completions', async () => {
    await tracker.complete(makeRequest());
    const records = tracker.getRecords();
    expect(records.length).toBe(1);
    expect(records[0].provider).toBe('deepseek');
    expect(records[0].agentId).toBe('agent-1');
    expect(records[0].success).toBe(true);
  });

  it('tracks failed completions', async () => {
    inner.complete.mockRejectedValueOnce(new Error('fail'));
    await expect(tracker.complete(makeRequest())).rejects.toThrow('fail');
    const records = tracker.getRecords();
    expect(records.length).toBe(1);
    expect(records[0].success).toBe(false);
    expect(records[0].error).toBe('fail');
  });

  it('computes cumulative stats', async () => {
    inner.complete
      .mockResolvedValueOnce(makeCompletionResponse({ usage: makeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) }))
      .mockResolvedValueOnce(makeCompletionResponse({ usage: makeUsage({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }) }));

    await tracker.complete(makeRequest({ model: 'deepseek-chat' }));
    await tracker.complete(makeRequest({ model: 'deepseek-reasoner' }));

    const stats = tracker.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalTokens).toBe(45);
    expect(stats.byModel['deepseek-chat']).toBeDefined();
    expect(stats.byModel['deepseek-reasoner']).toBeDefined();
  });

  it('can clear records', async () => {
    await tracker.complete(makeRequest());
    tracker.clearRecords();
    expect(tracker.getRecords().length).toBe(0);
  });
});

// ── Config Manager ────────────────────────────────────────────

describe('ConfigManager', () => {
  it('uses defaults when no config provided', () => {
    const mgr = new ConfigManager();
    const agent = mgr.getAgentConfig('agent-1');
    expect(agent.defaultModel).toBe('deepseek-chat');
    expect(agent.maxTokens).toBe(4096);
    expect(agent.temperature).toBe(0.7);
  });

  it('allows per-agent configuration', () => {
    const mgr = new ConfigManager({
      agents: {
        'agent-1': {
          agentId: 'agent-1',
          defaultModel: 'deepseek-reasoner',
          fallbackModels: ['deepseek-chat'],
          temperature: 0.3,
        },
      },
    });

    const agent = mgr.getAgentConfig('agent-1');
    expect(agent.defaultModel).toBe('deepseek-reasoner');
    expect(agent.temperature).toBe(0.3);

    const params = mgr.resolveParameters('agent-1');
    expect(params.temperature).toBe(0.3);
    expect(params.maxTokens).toBe(4096); // from defaults
  });

  it('resolveModel uses preferredModel over default', () => {
    const mgr = new ConfigManager({
      agents: {
        'agent-1': {
          agentId: 'agent-1',
          defaultModel: 'deepseek-chat',
          fallbackModels: [],
        },
      },
    });

    expect(mgr.resolveModel('agent-1')).toBe('deepseek-chat');
    expect(mgr.resolveModel('agent-1', 'deepseek-reasoner')).toBe('deepseek-reasoner');
  });

  it('can set and remove agent config', () => {
    const mgr = new ConfigManager();
    mgr.setAgentConfig('agent-2', { defaultModel: 'deepseek-reasoner' });
    expect(mgr.getAgentConfig('agent-2').defaultModel).toBe('deepseek-reasoner');

    mgr.removeAgentConfig('agent-2');
    expect(mgr.getAgentConfig('agent-2').defaultModel).toBe('deepseek-chat');
  });

  it('redacts API keys in JSON serialization', () => {
    const mgr = new ConfigManager({
      providers: {
        deepseek: { provider: 'deepseek', apiKey: 'sk-secret-123' },
      },
    });

    const json = mgr.toJSON();
    expect(json).not.toContain('sk-secret-123');
    expect(json).toContain('***REDACTED***');
  });

  it('round-trips through JSON without API keys', () => {
    const mgr = new ConfigManager({
      defaults: { maxTokens: 2048, temperature: 0.5, topP: 0.9 },
    });

    const restored = ConfigManager.fromJSON(mgr.toJSON());
    expect(restored.getConfig().defaults.maxTokens).toBe(2048);
    expect(restored.getConfig().defaults.temperature).toBe(0.5);
  });
});

// ── Factory ───────────────────────────────────────────────────

describe('createAIProviders', () => {
  it('creates providers with default config', () => {
    const providers = createAIProviders();
    expect(providers.configManager.getRegisteredProviders()).toContain('deepseek');
    expect(providers.router).toBeDefined();
  });

  it('creates providers with custom config', () => {
    const providers = createAIProviders({
      config: {
        providers: {
          deepseek: { provider: 'deepseek', apiKey: 'sk-test' },
        },
        defaults: { maxTokens: 2048, temperature: 0.5, topP: 1 },
      },
    });

    const config = providers.getConfig();
    expect(config.defaults.maxTokens).toBe(2048);
    expect(config.providers.deepseek).toBeDefined();
  });
});
