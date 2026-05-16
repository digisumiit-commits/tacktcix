// Re-export the canonical AIProvider interface from provider.ts
// This file provides the BaseProvider abstract class and additional
// provider configuration types used by the middleware stack.

import type { AIProvider } from './provider.js';

export type Provider = AIProvider;

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export abstract class BaseProvider implements AIProvider {
  abstract readonly info: import('../types/provider.js').ProviderInfo;

  protected readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = {
      timeoutMs: 120_000,
      maxRetries: 3,
      ...config,
    };
  }

  abstract healthCheck(): Promise<boolean>;
  abstract listModels(): Promise<import('../types/provider.js').ModelInfo[]>;
  abstract complete(
    request: import('../types/provider.js').CompletionRequest,
  ): Promise<import('../types/provider.js').CompletionResponse>;
  abstract completeStream(
    request: import('../types/provider.js').CompletionRequest,
  ): AsyncIterable<import('../types/provider.js').StreamChunk>;

  resolveModel(model: string): string {
    return model;
  }

  validateRequest(
    _request: import('../types/provider.js').CompletionRequest,
  ): string | null {
    return null;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    };
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
