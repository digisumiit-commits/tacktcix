import type { AIProvider } from '../providers/provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ModelInfo,
} from '../types/provider.js';
import { ProviderError } from '../types/ai-provider.js';
import type { ModelRouterConfig } from '../config/config.js';

interface ProviderEntry {
  provider: AIProvider;
  models: Set<string>;
}

interface RouteResult {
  provider: AIProvider;
  model: string;
}

export class ModelRouter {
  private providers = new Map<string, ProviderEntry>();
  private modelToProvider = new Map<string, string>();
  private config: ModelRouterConfig;

  constructor(config: ModelRouterConfig = {}) {
    this.config = {
      defaultProvider: 'deepseek',
      fallbackChain: [],
      ...config,
    };
  }

  registerProvider(provider: AIProvider, models?: string[]): void {
    const entry: ProviderEntry = {
      provider,
      models: new Set(models),
    };
    this.providers.set(provider.info.id, entry);

    if (models) {
      for (const model of models) {
        this.modelToProvider.set(model, provider.info.id);
      }
    }
  }

  async refreshModelMappings(): Promise<void> {
    this.modelToProvider.clear();
    for (const [, entry] of this.providers) {
      try {
        const models = await entry.provider.listModels();
        for (const model of models) {
          this.modelToProvider.set(model.id, entry.provider.info.id);
        }
      } catch {
        // Skip unavailable providers
      }
    }
  }

  async route(request: CompletionRequest): Promise<RouteResult> {
    const model = request.model;
    const providerName = this.resolveProvider(model);
    const provider = this.getProvider(providerName);

    if (!(await provider.healthCheck())) {
      return this.fallbackRoute(request);
    }

    const resolvedModel = provider.resolveModel(model);
    return { provider, model: resolvedModel };
  }

  resolveProvider(model: string): string {
    const direct = this.modelToProvider.get(model);
    if (direct) return direct;

    // Prefix matching
    for (const [modelId, provider] of this.modelToProvider) {
      if (model.startsWith(modelId) || modelId.startsWith(model)) {
        return provider;
      }
    }

    return this.config.defaultProvider ?? 'deepseek';
  }

  private async fallbackRoute(request: CompletionRequest): Promise<RouteResult> {
    const chain = this.config.fallbackChain ?? [];

    for (const fallbackProviderId of chain) {
      const fallbackProvider = this.getProvider(fallbackProviderId);
      if (await fallbackProvider.healthCheck()) {
        const models = await fallbackProvider.listModels();
        const compatible = models.find((m) => {
          if (request.tools && !m.supportsTools) return false;
          return true;
        });

        if (compatible) {
          return { provider: fallbackProvider, model: compatible.id };
        }
      }
    }

    throw new ProviderError(
      `No available provider for model "${request.model}" and all fallbacks exhausted`,
      'router',
    );
  }

  private getProvider(id: string): AIProvider {
    const entry = this.providers.get(id);
    if (!entry) {
      throw new ProviderError(`Provider "${id}" not registered`, 'router');
    }
    return entry.provider;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { provider, model } = await this.route(request);
    return provider.complete({ ...request, model });
  }

  completeStream(request: CompletionRequest): Promise<AsyncIterable<StreamChunk>> {
    return this.route(request).then(({ provider, model }) =>
      provider.completeStream({ ...request, model }),
    );
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const results: ModelInfo[] = [];
    for (const [, entry] of this.providers) {
      try {
        const models = await entry.provider.listModels();
        results.push(...models);
      } catch {
        // Skip unavailable
      }
    }
    return results;
  }

  getRegisteredProviders(): string[] {
    return [...this.providers.keys()];
  }
}
