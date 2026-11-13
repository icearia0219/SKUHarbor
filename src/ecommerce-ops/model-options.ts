import type { SimpleStreamOptions } from '@earendil-works/pi-ai';

export interface EcommerceModelOptionsInput {
  api: string;
  /** Server-owned provider configuration only. Never copied into diagnostics. */
  baseUrl: string;
  providerMaxTokens: number;
  taskMaxTokens: number;
  timeoutMs?: number;
}

/**
 * Pi's SimpleStreamOptions has no `reasoning: off` value. With product metadata
 * reasoning=false, even `minimal` is clamped off and emits no control field.
 * An omitted field is not an explicit provider-side disable. Only the verified
 * official host receives its documented per-request toggle for either protocol.
 *
 * Primary sources: installed pi-ai types.d.ts samplingParams; installed
 * api/openai-completions.js buildParams; api/anthropic-messages.js onPayload;
 * https://api-docs.deepseek.com/guides/thinking_mode/
 * https://api-docs.deepseek.com/guides/anthropic_api/
 */
export function ecommerceModelOptions(
  input: EcommerceModelOptionsInput,
): SimpleStreamOptions {
  for (const value of [input.providerMaxTokens, input.taskMaxTokens])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('INVALID_MODEL_OUTPUT_BUDGET');
  const timeout = input.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error('INVALID_MODEL_TIMEOUT');
  let officialHost = false;
  try {
    officialHost = new URL(input.baseUrl).hostname === 'api.deepseek.com';
  } catch {
    /* Invalid provider URLs are rejected upstream; never log them here. */
  }
  return {
    maxTokens: Math.min(input.providerMaxTokens, input.taskMaxTokens),
    timeoutMs: Math.min(timeout, 60_000),
    maxRetries: 0,
    ...(input.api === 'openai-completions' && officialHost
      ? { samplingParams: { thinking: { type: 'disabled' } } }
      : {}),
    ...(input.api === 'anthropic-messages' && officialHost
      ? {
          onPayload: (payload: unknown) => {
            if (
              !payload ||
              typeof payload !== 'object' ||
              Array.isArray(payload)
            )
              throw new Error('INVALID_PROVIDER_PAYLOAD');
            return { ...payload, thinking: { type: 'disabled' } };
          },
        }
      : {}),
  };
}

export interface ModelReplyLike {
  stopReason: string;
  rawStopReason?: string;
  content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>;
  usage?: { output?: number; reasoning?: number };
}
export interface ModelReplyDiagnostics {
  stop_reason: string;
  raw_stop_reason: string | null;
  text_blocks: number;
  text_chars: number;
  thinking_blocks: number;
  thinking_chars: number;
  tool_calls: number;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  ceiling_reached: boolean;
}
export type ModelReplyFailureCode =
  | 'MODEL_OUTPUT_LIMIT'
  | 'MODEL_THINKING_ONLY'
  | 'MODEL_EMPTY_OUTPUT'
  | 'MODEL_TOOL_OUTPUT'
  | 'MODEL_INCOMPLETE_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'CANCELLED';
export type ClassifiedModelReply =
  | { ok: true; text: string; diagnostics: ModelReplyDiagnostics }
  | {
      ok: false;
      code: ModelReplyFailureCode;
      diagnostics: ModelReplyDiagnostics;
    };
const safeTokens = (value: number | undefined): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value! : null;
const safeStopReasons = new Set([
  'pending',
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
  'deferred',
]);
const safeRawReasons = new Set([
  'stop',
  'end',
  'end_turn',
  'eos',
  'length',
  'max_tokens',
  'tool_use',
  'tool_calls',
  'function_call',
  'content_filter',
  'network_error',
]);

/** Never promote private thinking into an artifact, even when it looks like JSON. */
export function classifyEcommerceModelReply(
  reply: ModelReplyLike,
  options: {
    outputTokenLimit?: number;
    reasoningTokensReported?: boolean;
  } = {},
): ClassifiedModelReply {
  const text = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  const thinking = reply.content.filter((block) => block.type === 'thinking');
  const tools = reply.content.filter((block) => block.type === 'toolCall');
  const output = safeTokens(reply.usage?.output);
  const reportedReasoning = safeTokens(reply.usage?.reasoning);
  const diagnostics: ModelReplyDiagnostics = {
    stop_reason: safeStopReasons.has(reply.stopReason)
      ? reply.stopReason
      : 'other',
    raw_stop_reason:
      reply.rawStopReason === undefined
        ? null
        : safeRawReasons.has(reply.rawStopReason)
          ? reply.rawStopReason
          : 'other',
    text_blocks: reply.content.filter((block) => block.type === 'text').length,
    text_chars: text.length,
    thinking_blocks: thinking.length,
    thinking_chars: thinking.reduce(
      (sum, block) => sum + (block.thinking?.length ?? 0),
      0,
    ),
    tool_calls: tools.length,
    output_tokens: output,
    // The installed OpenAI adapter defaults an absent raw breakdown to zero.
    // A positive count is evidence; zero needs an explicit raw-field receipt.
    reasoning_tokens:
      reportedReasoning === 0 && options.reasoningTokensReported !== true
        ? null
        : reportedReasoning,
    ceiling_reached:
      output !== null &&
      Number.isSafeInteger(options.outputTokenLimit) &&
      options.outputTokenLimit! > 0 &&
      output >= options.outputTokenLimit!,
  };
  const fail = (code: ModelReplyFailureCode): ClassifiedModelReply => ({
    ok: false,
    code,
    diagnostics,
  });
  // An explicit truncation is authoritative even if the prefix parses as JSON.
  if (reply.stopReason === 'length') return fail('MODEL_OUTPUT_LIMIT');
  if (reply.stopReason === 'aborted') return fail('CANCELLED');
  if (reply.stopReason === 'error') return fail('MODEL_UNAVAILABLE');
  if (reply.stopReason === 'toolUse' || tools.length)
    return fail('MODEL_TOOL_OUTPUT');
  if (reply.stopReason !== 'stop') return fail('MODEL_INCOMPLETE_OUTPUT');
  if (!text.trim())
    return fail(thinking.length ? 'MODEL_THINKING_ONLY' : 'MODEL_EMPTY_OUTPUT');
  return { ok: true, text, diagnostics };
}
