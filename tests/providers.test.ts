import { describe, it, expect, vi, beforeEach } from 'vitest';

import { GroqProvider } from '../src/providers/groq.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import type { StreamChunk, TokenUsage } from '../src/types/provider.js';

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

// ── GroqProvider ──────────────────────────────────────────────

describe('GroqProvider', () => {
  let provider: GroqProvider;

  beforeEach(() => {
    provider = new GroqProvider({ apiKey: 'test-key' });
    vi.restoreAllMocks();
  });

  it('has correct provider info', () => {
    expect(provider.info.id).toBe('groq');
    expect(provider.info.name).toBe('Groq');
    expect(provider.info.defaultModel).toBe('llama3-70b-8192');
    expect(provider.info.supportsStreaming).toBe(true);
    expect(provider.info.supportsTools).toBe(true);
    expect(provider.info.supportsVision).toBe(false);
  });

  it('uses default baseUrl when none provided', () => {
    expect(provider['baseUrl']).toBe('https://api.groq.com/openai/v1');
  });

  it('accepts custom baseUrl', () => {
    const custom = new GroqProvider({ apiKey: 'key', baseUrl: 'https://custom.groq.com/v1' });
    expect(custom['baseUrl']).toBe('https://custom.groq.com/v1');
  });

  it('listModels returns Groq models', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.find((m) => m.id === 'llama3-70b-8192')).toBeDefined();
    expect(models.find((m) => m.id === 'llama3-8b-8192')).toBeDefined();
    expect(models.find((m) => m.id === 'mixtral-8x7b-32768')).toBeDefined();
    expect(models.find((m) => m.id === 'gemma2-9b-it')).toBeDefined();

    for (const model of models) {
      expect(model.providerId).toBe('groq');
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });

  it('healthCheck returns true on 200', async () => {
    mockFetch({ status: 200, data: { data: [] } });
    expect(await provider.healthCheck()).toBe(true);
  });

  it('healthCheck returns false on 401', async () => {
    mockFetch({ status: 401 });
    expect(await provider.healthCheck()).toBe(false);
  });

  it('complete sends request and parses response', async () => {
    const rawResponse = {
      id: 'chatcmpl-1',
      model: 'llama3-70b-8192',
      created: 1700000000,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Groq!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    mockFetch({ status: 200, data: rawResponse });

    const response = await provider.complete({
      model: 'llama3-70b-8192',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.id).toBe('chatcmpl-1');
    expect(response.model).toBe('llama3-70b-8192');
    expect(response.provider).toBe('groq');
    expect(response.choices[0].message.content).toBe('Hello from Groq!');
    expect(response.usage).toBeDefined();
  });

  it('completeStream yields chunks', async () => {
    const chunks = [
      'data: {"id":"r1","model":"llama3-70b-8192","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n',
      'data: {"id":"r1","model":"llama3-70b-8192","created":1,"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
      'data: [DONE]\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), body: stream, json: async () => ({}),
    } as Response);

    const results: StreamChunk[] = [];
    for await (const chunk of provider.completeStream({ model: 'llama3-70b-8192', messages: [{ role: 'user', content: 'Hi' }], stream: true })) {
      results.push(chunk);
    }

    expect(results.length).toBe(2);
    expect(results[0].choices[0].delta.role).toBe('assistant');
    expect(results[1].choices[0].delta.content).toBe('Hello');
  });

  it('computeCost returns correct values', () => {
    const cost = provider.computeCost('llama3-70b-8192', makeUsage({ prompt_tokens: 1000, completion_tokens: 1000 }));
    expect(cost).toBeCloseTo(0.00059 + 0.00079, 5);
  });

  it('computeCost returns undefined for unknown model', () => {
    expect(provider.computeCost('unknown-model', makeUsage())).toBeUndefined();
  });

  it('getPricing returns pricing for known model', () => {
    const pricing = provider.getPricing('llama3-8b-8192');
    expect(pricing).toBeDefined();
    expect(pricing!.inputCostPer1K).toBe(0.00005);
    expect(pricing!.outputCostPer1K).toBe(0.00008);
  });

  it('getPricing returns undefined for unknown model', () => {
    expect(provider.getPricing('unknown')).toBeUndefined();
  });

  it('resolveModel returns default for unknown', () => {
    expect(provider.resolveModel('unknown')).toBe('llama3-70b-8192');
  });

  it('validateRequest rejects tools on non-tool model', () => {
    const result = provider.validateRequest({
      model: 'mixtral-8x7b-32768',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    });
    expect(result).toContain('does not support tools');
  });
});

// ── OllamaProvider ────────────────────────────────────────────

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider({ apiKey: '' });
    vi.restoreAllMocks();
  });

  it('has correct provider info', () => {
    expect(provider.info.id).toBe('ollama');
    expect(provider.info.name).toBe('Ollama');
    expect(provider.info.defaultModel).toBe('llama3.2');
    expect(provider.info.supportsVision).toBe(true);
  });

  it('uses localhost baseUrl by default', () => {
    expect(provider['baseUrl']).toBe('http://localhost:11434/v1');
  });

  it('listModels returns Ollama models', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.find((m) => m.id === 'llama3.2')).toBeDefined();
    expect(models.find((m) => m.id === 'llama3.2-vision')).toBeDefined();
    expect(models.find((m) => m.id === 'mistral')).toBeDefined();
    expect(models.find((m) => m.id === 'codellama')).toBeDefined();
  });

  it('computeCost returns 0 for local models', () => {
    const cost = provider.computeCost('llama3.2', makeUsage({ prompt_tokens: 1000, completion_tokens: 500 }));
    expect(cost).toBe(0);
  });

  it('complete sends request and parses response', async () => {
    const rawResponse = {
      id: 'chatcmpl-1',
      model: 'llama3.2',
      created: 1700000000,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Ollama!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    mockFetch({ status: 200, data: rawResponse });

    const response = await provider.complete({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.provider).toBe('ollama');
    expect(response.choices[0].message.content).toBe('Hello from Ollama!');
  });

  it('completeStream yields chunks', async () => {
    const chunks = [
      'data: {"id":"r1","model":"llama3.2","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n',
      'data: {"id":"r1","model":"llama3.2","created":1,"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n',
    ];

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), body: stream, json: async () => ({}),
    } as Response);

    const results: StreamChunk[] = [];
    for await (const chunk of provider.completeStream({ model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }], stream: true })) {
      results.push(chunk);
    }

    expect(results.length).toBe(2);
  });

  it('resolveModel returns default for unknown', () => {
    expect(provider.resolveModel('nonexistent')).toBe('llama3.2');
  });

  it('rejects tools on non-tool model', () => {
    const result = provider.validateRequest({
      model: 'codellama',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
    });
    expect(result).toContain('does not support tools');
  });
});
