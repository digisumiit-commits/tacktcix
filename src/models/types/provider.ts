import { z } from 'zod';

// ── Message types ──────────────────────────────────────────────

export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageContentSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextContentSchema,
  ImageContentSchema,
]);

export const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().or(z.array(ContentBlockSchema)),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })
    )
    .optional(),
});

export type Message = z.infer<typeof MessageSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;

// ── Tool types ──────────────────────────────────────────────────

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  }),
});

export type Tool = z.infer<typeof ToolSchema>;

// ── Completion request/response ─────────────────────────────────

export const CompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(ToolSchema).optional(),
  tool_choice: z
    .union([z.literal('auto'), z.literal('none'), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) })])
    .optional(),
  stream: z.boolean().optional().default(false),
});

export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

export const TokenUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const CompletionChoiceSchema = z.object({
  index: z.number(),
  message: MessageSchema,
  finish_reason: z
    .enum(['stop', 'length', 'tool_calls', 'content_filter'])
    .nullable(),
});

export const CompletionResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  choices: z.array(CompletionChoiceSchema),
  usage: TokenUsageSchema.optional(),
  created: z.number(),
});

export type CompletionResponse = z.infer<typeof CompletionResponseSchema>;

// ── Streaming ───────────────────────────────────────────────────

export const StreamChunkSchema = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        role: z.string().optional(),
        content: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().optional(),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z
                .object({
                  name: z.string().optional(),
                  arguments: z.string().optional(),
                })
                .optional(),
            })
          )
          .optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    })
  ),
});

export type StreamChunk = z.infer<typeof StreamChunkSchema>;

// ── Provider info ───────────────────────────────────────────────

export interface ProviderInfo {
  id: string;
  name: string;
  models: string[];
  defaultModel: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  maxTokens: Record<string, number>;
}

// ── Provider capability flags ───────────────────────────────────

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  json_mode: boolean;
  parallel_tool_calls: boolean;
}

// ── Model info ──────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  providerId: string;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}
