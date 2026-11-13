import { describe, expect, it } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import {
  ecommerceModelOptions,
  classifyEcommerceModelReply,
} from '../../src/ecommerce-ops/model-options.js';

function sdkModel(): Model<'openai-completions'> {
  return {
    id: 'synthetic-offline-model',
    name: 'Synthetic offline model',
    provider: 'synthetic-offline',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
const config = {
  api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com/v1',
  providerMaxTokens: 4096,
  taskMaxTokens: 4096,
};
function transport(
  delta: Record<string, unknown>,
  finish = 'stop',
  reasoning = 0,
) {
  let payload: any;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(
      'data: ' +
        JSON.stringify({
          id: 'synthetic-response',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'synthetic-offline-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: finish === 'length' ? 4096 : 2,
            total_tokens: finish === 'length' ? 4101 : 7,
            completion_tokens_details: { reasoning_tokens: reasoning },
          },
        }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  return { fetch, payload: () => payload };
}

describe('bounded ecommerce output and safe reasoning diagnostics', () => {
  it('never raises configured or task output ceilings and never adds transport retries', () => {
    expect(ecommerceModelOptions(config)).toMatchObject({
      maxTokens: 4096,
      maxRetries: 0,
      timeoutMs: 60000,
    });
    expect(
      ecommerceModelOptions({ ...config, providerMaxTokens: 2048 }).maxTokens,
    ).toBe(2048);
    expect(
      ecommerceModelOptions({ ...config, providerMaxTokens: 16384 }).maxTokens,
    ).toBe(4096);
    expect(
      ecommerceModelOptions({ ...config, timeoutMs: 120000 }).timeoutMs,
    ).toBe(60000);
    for (const value of [0, -1, 1.5, Number.NaN])
      expect(() =>
        ecommerceModelOptions({ ...config, taskMaxTokens: value }),
      ).toThrow();
  });
  it('applies disabled thinking only to the exact verified API and official hostname', () => {
    expect(ecommerceModelOptions(config).samplingParams).toEqual({
      thinking: { type: 'disabled' },
    });
    for (const patch of [
      { baseUrl: 'https://api.deepseek.com.evil/v1' },
      { baseUrl: 'https://other.example/v1' },
      { baseUrl: 'not a URL' },
      { api: 'anthropic-messages', baseUrl: 'https://other.example/anthropic' },
    ])
      expect(
        ecommerceModelOptions({ ...config, ...patch }).samplingParams,
      ).toBeUndefined();
  });
  it('explicitly disables thinking in the official Anthropic payload without raising max_tokens', async () => {
    let payload: any;
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_synthetic',
          type: 'message',
          role: 'assistant',
          model: 'synthetic-offline-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '{}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const options = ecommerceModelOptions({
      ...config,
      api: 'anthropic-messages',
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    expect(options.samplingParams).toBeUndefined();
    expect(options.onPayload).toBeTypeOf('function');
    const reply = await anthropicStreamSimple(
      {
        ...sdkModel(),
        api: 'anthropic-messages',
        baseUrl: 'https://api.deepseek.com/anthropic',
      },
      {
        messages: [
          { role: 'user', content: 'Synthetic offline request', timestamp: 0 },
        ],
      },
      { ...options, apiKey: 'synthetic-offline-token', fetch },
    ).result();
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.max_tokens).toBe(4096);
    expect(reply.stopReason).toBe('stop');
    expect(classifyEcommerceModelReply(reply)).toMatchObject({
      ok: true,
      text: '{}',
    });
    expect(
      ecommerceModelOptions({
        ...config,
        api: 'anthropic-messages',
        baseUrl: 'https://other.example/anthropic',
      }).onPayload,
    ).toBeUndefined();
  });
  it('proves from the installed SDK that reasoning minimal is clamped off when product metadata reasoning=false', async () => {
    const server = transport({ content: '{}' });
    const reply = await streamSimple(
      sdkModel(),
      {
        messages: [
          {
            role: 'user',
            content: 'Synthetic local-only request',
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: 'synthetic-never-sent-to-network',
        fetch: server.fetch,
        reasoning: 'minimal',
        maxTokens: 4096,
        maxRetries: 0,
      },
    ).result();
    expect(reply.stopReason).toBe('stop');
    expect(server.payload().reasoning_effort).toBeUndefined();
    expect(server.payload().thinking).toBeUndefined();
  });
  it('sends an explicit disabled field through the installed SDK without changing the model or token cap', async () => {
    const server = transport({ content: '{}' });
    await streamSimple(
      sdkModel(),
      {
        messages: [
          {
            role: 'user',
            content: 'Synthetic local-only request',
            timestamp: 0,
          },
        ],
      },
      {
        ...ecommerceModelOptions(config),
        apiKey: 'synthetic-never-sent-to-network',
        fetch: server.fetch,
      },
    ).result();
    expect(server.payload().thinking).toEqual({ type: 'disabled' });
    expect(server.payload().max_tokens).toBe(4096);
    expect(server.payload().model).toBe('synthetic-offline-model');
  });
  it('recognizes SDK-normalized reasoning-only length exhaustion without treating thinking as an answer', async () => {
    const server = transport(
      { reasoning_content: 'private chain text fixture' },
      'length',
      4096,
    );
    const reply = await streamSimple(
      sdkModel(),
      {
        messages: [
          {
            role: 'user',
            content: 'Synthetic local-only request',
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: 'synthetic-never-sent-to-network',
        fetch: server.fetch,
        maxTokens: 4096,
        maxRetries: 0,
      },
    ).result();
    expect(reply.stopReason).toBe('length');
    const outcome = classifyEcommerceModelReply(reply, {
      outputTokenLimit: 4096,
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: 'MODEL_OUTPUT_LIMIT',
      diagnostics: {
        stop_reason: 'length',
        thinking_blocks: 1,
        text_blocks: 0,
        output_tokens: 4096,
        reasoning_tokens: 4096,
        ceiling_reached: true,
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('private chain text fixture');
  });
  it('rejects even JSON-looking text if the provider explicitly stopped for length', () => {
    const outcome = classifyEcommerceModelReply({
      stopReason: 'length',
      content: [{ type: 'text', text: '{}' }],
      usage: { output: 4096 },
    });
    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_OUTPUT_LIMIT' });
  });
  it('distinguishes empty, thinking-only and usable text without inferring an unreported cause', () => {
    expect(
      classifyEcommerceModelReply(
        { stopReason: 'stop', content: [], usage: { output: 4096 } },
        { outputTokenLimit: 4096 },
      ),
    ).toMatchObject({
      ok: false,
      code: 'MODEL_EMPTY_OUTPUT',
      diagnostics: { ceiling_reached: true, reasoning_tokens: null },
    });
    expect(
      classifyEcommerceModelReply({
        stopReason: 'stop',
        content: [{ type: 'thinking', thinking: 'hidden' }],
        usage: { output: 100 },
      }),
    ).toMatchObject({ ok: false, code: 'MODEL_THINKING_ONLY' });
    const complete = classifyEcommerceModelReply({
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: '{"visible":true}' },
      ],
      usage: { output: 102 },
    });
    expect(complete).toMatchObject({ ok: true, text: '{"visible":true}' });
    expect(JSON.stringify(complete)).not.toContain('hidden');
  });
  it('does not interpret SDK default reasoning=0 as a provider-confirmed zero count', () => {
    const reply = {
      stopReason: 'stop',
      content: [{ type: 'text', text: '{}' }],
      usage: { output: 2, reasoning: 0 },
    };
    expect(
      classifyEcommerceModelReply(reply).diagnostics.reasoning_tokens,
    ).toBeNull();
    expect(
      classifyEcommerceModelReply(reply, { reasoningTokensReported: true })
        .diagnostics.reasoning_tokens,
    ).toBe(0);
  });
  it('classifies incomplete, cancelled, provider error and unexpected tool outputs safely', () => {
    for (const [stopReason, code] of [
      ['pending', 'MODEL_INCOMPLETE_OUTPUT'],
      ['deferred', 'MODEL_INCOMPLETE_OUTPUT'],
      ['aborted', 'CANCELLED'],
      ['error', 'MODEL_UNAVAILABLE'],
      ['toolUse', 'MODEL_TOOL_OUTPUT'],
    ])
      expect(
        classifyEcommerceModelReply({
          stopReason,
          content: [],
          usage: { output: 0 },
        }),
      ).toMatchObject({ ok: false, code });
    const output = classifyEcommerceModelReply({
      stopReason: 'stop',
      rawStopReason: 'sensitive raw error or endpoint',
      content: [{ type: 'toolCall' }],
      usage: { output: 0 },
    });
    expect(output).toMatchObject({
      ok: false,
      code: 'MODEL_TOOL_OUTPUT',
      diagnostics: { raw_stop_reason: 'other' },
    });
    expect(JSON.stringify(output)).not.toContain('sensitive');
  });
});
