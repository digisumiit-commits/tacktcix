import type { AIProvider } from '../providers/provider.js';

export interface AgentModelConfig {
  agentId: string;
  defaultModel: string;
  fallbackModels: string[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  systemPrompt?: string;
}

export interface ProviderConnectionConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    concurrentRequests?: number;
  };
}

export interface ModelRouterConfig {
  defaultProvider?: string;
  fallbackChain?: string[];
}

export interface AIConfig {
  providers: Record<string, ProviderConnectionConfig>;
  agents: Record<string, AgentModelConfig>;
  router: ModelRouterConfig;
  defaults: {
    maxTokens: number;
    temperature: number;
    topP: number;
  };
}

type AgentId = string;

export const DEFAULT_CONFIG: AIConfig = {
  providers: {},
  agents: {},
  router: {
    defaultProvider: 'deepseek',
    fallbackChain: [],
  },
  defaults: {
    maxTokens: 4096,
    temperature: 0.7,
    topP: 1,
  },
};

export class ConfigManager {
  private config: AIConfig;
  private providers = new Map<string, AIProvider>();

  constructor(config: Partial<AIConfig> = {}) {
    this.config = this.mergeConfig(config);
  }

  // ── Provider registration ───────────────────────────────────

  registerProvider(name: string, provider: AIProvider): void {
    this.providers.set(name, provider);
  }

  getProvider(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  getRegisteredProviders(): string[] {
    return [...this.providers.keys()];
  }

  // ── Agent config ─────────────────────────────────────────────

  getAgentConfig(agentId: AgentId): AgentModelConfig {
    const agentConfig = this.config.agents[agentId];
    if (agentConfig) return agentConfig;

    return {
      agentId,
      defaultModel: 'deepseek-chat',
      fallbackModels: [],
      maxTokens: this.config.defaults.maxTokens,
      temperature: this.config.defaults.temperature,
      topP: this.config.defaults.topP,
    };
  }

  setAgentConfig(agentId: AgentId, config: Partial<AgentModelConfig>): void {
    const existing = this.config.agents[agentId] ?? this.getAgentConfig(agentId);
    this.config.agents[agentId] = { ...existing, ...config, agentId };
  }

  removeAgentConfig(agentId: AgentId): void {
    delete this.config.agents[agentId];
  }

  resolveModel(agentId: AgentId, preferredModel?: string): string {
    const agent = this.getAgentConfig(agentId);
    return preferredModel ?? agent.defaultModel;
  }

  resolveParameters(agentId: AgentId, overrides?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  }): { maxTokens: number; temperature: number; topP: number } {
    const agent = this.getAgentConfig(agentId);
    return {
      maxTokens: overrides?.maxTokens ?? agent.maxTokens ?? this.config.defaults.maxTokens,
      temperature: overrides?.temperature ?? agent.temperature ?? this.config.defaults.temperature,
      topP: overrides?.topP ?? agent.topP ?? this.config.defaults.topP,
    };
  }

  // ── Provider config ─────────────────────────────────────────

  getProviderConfig(providerName: string): ProviderConnectionConfig | undefined {
    return this.config.providers[providerName];
  }

  setProviderConfig(providerName: string, config: ProviderConnectionConfig): void {
    this.config.providers[providerName] = config;
  }

  // ── Router config ───────────────────────────────────────────

  getRouterConfig(): ModelRouterConfig {
    return { ...this.config.router };
  }

  setRouterConfig(config: Partial<ModelRouterConfig>): void {
    this.config.router = { ...this.config.router, ...config };
  }

  // ── Full config ─────────────────────────────────────────────

  getConfig(): Readonly<AIConfig> {
    return this.config;
  }

  updateConfig(partial: Partial<AIConfig>): void {
    this.config = this.mergeConfig(partial);
  }

  // ── Serialization ───────────────────────────────────────────

  toJSON(): string {
    const safe = structuredClone(this.config);
    for (const key of Object.keys(safe.providers)) {
      safe.providers[key].apiKey = '***REDACTED***';
    }
    return JSON.stringify(safe, null, 2);
  }

  static fromJSON(json: string): ConfigManager {
    const parsed = JSON.parse(json) as Partial<AIConfig>;
    return new ConfigManager(parsed);
  }

  // ── Helpers ─────────────────────────────────────────────────

  private mergeConfig(partial: Partial<AIConfig>): AIConfig {
    return {
      providers: { ...DEFAULT_CONFIG.providers, ...partial.providers },
      agents: { ...DEFAULT_CONFIG.agents, ...partial.agents },
      router: { ...DEFAULT_CONFIG.router, ...partial.router },
      defaults: { ...DEFAULT_CONFIG.defaults, ...partial.defaults },
    };
  }
}
