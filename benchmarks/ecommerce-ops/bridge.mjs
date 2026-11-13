import fs from 'node:fs';
import { createHash } from 'node:crypto';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });
const MODEL_FAILURE_CODES = new Set([
  'MODEL_OUTPUT_LIMIT',
  'MODEL_THINKING_ONLY',
  'MODEL_EMPTY_OUTPUT',
  'MODEL_TOOL_OUTPUT',
  'MODEL_INCOMPLETE_OUTPUT',
  'MODEL_UNAVAILABLE',
  'BUDGET_EXHAUSTED',
  'CONTEXT_BUDGET_EXHAUSTED',
  'CANCELLED',
  'OWNER_UNAVAILABLE',
]);

async function boundedJson(response, limit) {
  if (!response.body) throw failure('BRIDGE_RESPONSE_INVALID');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw failure('BRIDGE_RESPONSE_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw failure('BRIDGE_RESPONSE_INVALID');
  }
}

/** Error responses never authorize arbitrary strings, diagnostics or raw identity. */
function safeFailureUsage(input) {
  if (!input || typeof input !== 'object') return undefined;
  try {
    return safeModelUsage({
      model_ref:
        typeof input.model_ref === 'string' &&
        /^sha256:[a-f0-9]{64}$/.test(input.model_ref)
          ? input.model_ref
          : null,
      input_tokens: input.input_tokens ?? null,
      output_tokens: input.output_tokens ?? null,
      retry_count: input.retry_count ?? 0,
      model_elapsed_ms: input.model_elapsed_ms ?? null,
      cost_usd: input.cost_usd ?? null,
      price_version: null,
    });
  } catch {
    return undefined;
  }
}

export function validateBridgeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure('BRIDGE_URL_INVALID');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw failure('BRIDGE_LOOPBACK_REQUIRED');
  return url.origin;
}

export function readBridgeToken(filename) {
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 32 ||
    stat.size > 4096
  )
    throw failure('BRIDGE_TOKEN_FILE_INVALID');
  const value = fs.readFileSync(filename, 'utf8').trim();
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(value))
    throw failure('BRIDGE_TOKEN_INVALID');
  return value;
}

export function safeModelUsage(input) {
  if (!input || typeof input !== 'object')
    throw failure('BRIDGE_USAGE_INVALID');
  const integer = (name) => {
    const value = input[name];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw failure('BRIDGE_USAGE_INVALID');
    return value;
  };
  const finite = (name) => {
    const value = input[name];
    if (
      value !== null &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    )
      throw failure('BRIDGE_USAGE_INVALID');
    return value;
  };
  const reference =
    typeof input.model_ref === 'string' ? input.model_ref : null;
  const price =
    typeof input.price_version === 'string' && input.price_version.trim()
      ? input.price_version
      : null;
  const rawCost = finite('cost_usd');
  return {
    model_ref: reference
      ? /^sha256:[a-f0-9]{64}$/.test(reference)
        ? reference
        : 'sha256:' + sha(reference)
      : null,
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    retry_count: integer('retry_count'),
    model_elapsed_ms: finite('model_elapsed_ms'),
    cost_usd: price ? rawCost : null,
    price_version: price,
  };
}

/** No provider SDK, credentials or endpoint; the bridge owns production model admission. */
export function createBridgeModel({
  url,
  token,
  timeoutMs = 60000,
  onAttempt,
}) {
  const origin = validateBridgeUrl(url);
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token ?? ''))
    throw failure('BRIDGE_TOKEN_INVALID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw failure('BRIDGE_TIMEOUT_INVALID');
  return async (generation) => {
    const started = performance.now();
    const emit = (details) => {
      try {
        onAttempt?.({ ...details, elapsed_ms: performance.now() - started });
      } catch {
        /* telemetry cannot authorize or block inference */
      }
    };
    const task = {
      ...generation.task,
      request: { ...generation.task.request },
    };
    // Only frozen, already minimized context crosses the broker boundary.
    delete task.request.support;
    delete task.snapshot;
    const variant = generation.variant ?? 'B';
    if (!['A', 'B'].includes(variant)) throw failure('BRIDGE_VARIANT_INVALID');
    const body = JSON.stringify({
      task,
      snapshot: generation.snapshot,
      repair: generation.repair,
      variant,
    });
    if (Buffer.byteLength(body) > 512 * 1024)
      throw failure('BRIDGE_CONTEXT_LIMIT');
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(60000, timeoutMs)),
    );
    const signal = generation.signal
      ? AbortSignal.any([generation.signal, timeout])
      : timeout;
    let status;
    try {
      const response = await fetch(origin + '/v1/generate', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body,
      });
      status = response.status;
      if (!response.ok) {
        let payload;
        if (
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .startsWith('application/json')
        ) {
          try {
            payload = await boundedJson(response, 16 * 1024);
          } catch {
            /* Invalid/oversized error bodies never become diagnostic text. */
          }
        } else await response.body?.cancel();
        const baseline = [401, 403].includes(status)
          ? 'BRIDGE_AUTH_DENIED'
          : [402, 429].includes(status)
            ? 'BUDGET_EXHAUSTED'
            : 'BRIDGE_HTTP_' + status;
        const header = response.headers.get('x-opendot-model-code');
        const reported = MODEL_FAILURE_CODES.has(header)
          ? header
          : MODEL_FAILURE_CODES.has(payload?.code)
            ? payload.code
            : null;
        const error = failure(
          [401, 403].includes(status) ? baseline : (reported ?? baseline),
        );
        const usage = safeFailureUsage(payload?.usage);
        if (usage) error.usage = usage;
        throw error;
      }
      if (
        !response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('application/json') ||
        !response.body
      )
        throw failure('BRIDGE_RESPONSE_INVALID');
      const reply = await boundedJson(response, 256 * 1024);
      if (typeof reply.text !== 'string' || !reply.text.trim())
        throw failure('BRIDGE_RESPONSE_INVALID');
      const usage = safeModelUsage(reply.usage);
      emit({
        status: 'done',
        http_status: status,
        request_sha256: sha(body),
        output_sha256: sha(reply.text),
        usage,
      });
      return { text: reply.text, usage };
    } catch (error) {
      const code = signal.aborted
        ? 'BUDGET_EXHAUSTED'
        : MODEL_FAILURE_CODES.has(error?.code) ||
            /^BRIDGE_[A-Z0-9_]+$/.test(error?.code ?? '')
          ? error.code
          : 'BRIDGE_TRANSPORT_FAILED';
      const usage = safeFailureUsage(error?.usage);
      emit({
        status: 'error',
        code,
        ...(status ? { http_status: status } : {}),
        request_sha256: sha(body),
        ...(usage ? { usage } : {}),
      });
      // Never propagate an upstream body, URL, token, response text or cause.
      const safe = failure(code);
      if (usage) safe.usage = usage;
      throw safe;
    }
  };
}
