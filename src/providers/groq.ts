import { OpenAICompatibleProvider, type ModelEntry } from './openai-compatible.js';
import type { ProviderConfig } from './interface.js';
import type { ProviderInfo } from '../types/provider.js';

const GROQ_MODEL_DATA: Record<string, ModelEntry> = {
  'llama3-70b-8192': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    pricing: { inputCostPer1K: 0.00059, outputCostPer1K: 0.00079, currency: 'USD' },
  },
  'llama3-8b-8192': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    pricing: { inputCostPer1K: 0.00005, outputCostPer1K: 0.00008, currency: 'USD' },
  },
  'mixtral-8x7b-32768': {
    maxTokens: 32_768,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
    pricing: { inputCostPer1K: 0.00024, outputCostPer1K: 0.00024, currency: 'USD' },
  },
  'gemma2-9b-it': {
    maxTokens: 8_192,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
    pricing: { inputCostPer1K: 0.00005, outputCostPer1K: 0.00008, currency: 'USD' },
  },
};

const GROQ_MODEL_IDS = Object.keys(GROQ_MODEL_DATA);

export class GroqProvider extends OpenAICompatibleProvider {
  readonly info: ProviderInfo = {
    id: 'groq',
    name: 'Groq',
    models: GROQ_MODEL_IDS,
    defaultModel: 'llama3-70b-8192',
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    maxTokens: Object.fromEntries(
      GROQ_MODEL_IDS.map((id) => [id, GROQ_MODEL_DATA[id].maxTokens]),
    ),
  };

  constructor(config: Partial<ProviderConfig> = {}) {
    super({
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl ?? 'https://api.groq.com/openai/v1',
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      headers: config.headers,
    });

    Object.assign(this.modelData, GROQ_MODEL_DATA);
    this.defaultModelId = 'llama3-70b-8192';
  }
}
