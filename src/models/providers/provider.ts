import {
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderInfo,
  ProviderCapabilities,
  ModelInfo,
} from '../types/provider';

export interface AIProvider {
  readonly info: ProviderInfo;

  /** Check if the provider is healthy and configured */
  healthCheck(): Promise<boolean>;

  /** List available models */
  listModels(): Promise<ModelInfo[]>;

  /** Send a non-streaming completion request */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /** Send a streaming completion request. Yields chunks via async iterable. */
  completeStream(request: CompletionRequest): AsyncIterable<StreamChunk>;

  /** Resolve the actual model name (provider may map aliases) */
  resolveModel(model: string): string;

  /** Validate that a given model + request combination is supported */
  validateRequest(request: CompletionRequest): string | null;
}
