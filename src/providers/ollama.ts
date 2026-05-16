import { OpenAICompatibleProvider, type ModelEntry } from './openai-compatible.js';
import type { ProviderConfig } from './interface.js';
import type { ProviderInfo } from '../types/provider.js';

const OLLAMA_MODEL_DATA: Record<string, ModelEntry> = {
  'llama3.2': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    pricing: { inputCostPer1K: 0, outputCostPer1K: 0, currency: 'USD' },
  },
  'llama3.2-vision': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: true,
    pricing: { inputCostPer1K: 0, outputCostPer1K: 0, currency: 'USD' },
  },
  'mistral': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    pricing: { inputCostPer1K: 0, outputCostPer1K: 0, currency: 'USD' },
  },
  'codellama': {
    maxTokens: 16_384,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
    pricing: { inputCostPer1K: 0, outputCostPer1K: 0, currency: 'USD' },
  },
};

const OLLAMA_MODEL_IDS = Object.keys(OLLAMA_MODEL_DATA);

export class OllamaProvider extends OpenAICompatibleProvider {
  readonly info: ProviderInfo = {
    id: 'ollama',
    name: 'Ollama',
    models: OLLAMA_MODEL_IDS,
    defaultModel: 'llama3.2',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    maxTokens: Object.fromEntries(
      OLLAMA_MODEL_IDS.map((id) => [id, OLLAMA_MODEL_DATA[id].maxTokens]),
    ),
  };

  constructor(config: Partial<ProviderConfig> = {}) {
    super({
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      headers: config.headers,
    });

    Object.assign(this.modelData, OLLAMA_MODEL_DATA);
    this.defaultModelId = 'llama3.2';
  }
}
