/** Isolated, bounded bridge to the existing encrypted provider configuration.
 * The model never receives account files. No user database or live service is changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeBrokerScratch } from './ecommerce-broker-scratch.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url)),
  args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const source = option('--provider-from');
if (!source)
  throw new Error('--provider-from <existing OpenDot directory> is required');
const output = path.resolve(
  option(
    '--output',
    path.join(repo, 'artifacts/ecommerce-ops/real-model', `run-${Date.now()}`),
  ),
);
if (fs.existsSync(path.join(output, 'summary.json')))
  throw new Error('Use a new evidence directory');
const maxCalls = Number(option('--max-calls', '12'));
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 300)
  throw new Error('max-calls must be 1..300');
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'opendot-ecommerce-model-'),
);
const workspace = 'web:ecommerce-model-broker',
  owner = 'ecommerce-model-owner';
const oldCwd = process.cwd();
let server,
  db,
  closed = false,
  calls = 0;
const observations = [];
fs.mkdirSync(output, { recursive: true });
fs.symlinkSync(
  path.join(repo, 'node_modules'),
  path.join(scratch, 'node_modules'),
  'junction',
);
fs.writeFileSync(
  path.join(scratch, 'package.json'),
  '{"type":"module","private":true}',
);
process.env.OPENDOT_ECOMMERCE_OPS = 'true';
process.chdir(scratch);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const importSource = (p) => import(pathToFileURL(path.join(repo, p)).href);
async function cleanup() {
  if (closed) return;
  closed = true;
  try {
    await new Promise((resolve) =>
      server ? server.close(resolve) : resolve(),
    );
  } catch {}
  try {
    db?.closeDatabase();
  } catch {}
  fs.writeFileSync(
    path.join(output, 'summary.json'),
    JSON.stringify(
      {
        configured: true,
        provider_identity: 'redacted',
        max_calls: maxCalls,
        actual_calls: calls,
        observations,
        online_business_validation: false,
      },
      null,
      2,
    ),
  );
  process.chdir(oldCwd);
  const real = fs.realpathSync(scratch),
    temp = fs.realpathSync(os.tmpdir());
  if (
    real.startsWith(temp + path.sep) &&
    path.basename(real).startsWith('opendot-ecommerce-model-')
  ) {
    try {
      removeBrokerScratch(scratch);
    } catch (error) {
      fs.writeFileSync(
        path.join(output, 'cleanup.json'),
        JSON.stringify(
          {
            status: 'directory_cleanup_pending',
            error_code: /^[A-Z_]+$/.test(error?.code ?? '')
              ? error.code
              : 'CLEANUP_FAILED',
            directory: real,
            credential_copies_remaining: [
              'claude-provider.json',
              'claude-provider.key',
              'broker-token.txt',
            ].filter((name) =>
              fs.existsSync(path.join(real, 'data/config', name)),
            ),
          },
          null,
          2,
        ),
      );
    }
  }
}
try {
  const { ensureWindowsPrivateDataDirectory } = await importSource(
    'src/windows-private-data.ts',
  );
  ensureWindowsPrivateDataDirectory(path.join(scratch, 'data'));
  const config = path.join(scratch, 'data/config');
  fs.mkdirSync(config, { recursive: true });
  for (const name of ['claude-provider.json', 'claude-provider.key']) {
    const origin = path.resolve(source, 'data/config', name);
    if (!fs.existsSync(origin)) throw new Error('PROVIDER_NOT_CONFIGURED');
    fs.copyFileSync(origin, path.join(config, name));
  }
  db = await importSource('src/db.ts');
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: owner,
    username: owner,
    password_hash: 'isolated-no-http-login',
    display_name: 'Synthetic model verification',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.setRegisteredGroup(workspace, {
    name: 'Isolated ecommerce verification',
    folder: 'ecommerce-model-broker',
    executionMode: 'container',
    created_by: owner,
    added_at: now,
  });
  const { configuredModel } = await importSource('src/ecommerce-ops/model.ts');
  const { productModelConfiguration } = await importSource(
    'src/personal-agent/product-model.ts',
  );
  productModelConfiguration(workspace, undefined, {
    allowContainerWorkspace: true,
  });
  const token = randomBytes(32).toString('hex'),
    tokenFile = path.join(config, 'broker-token.txt');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/health') {
      res.end(
        JSON.stringify({
          ready: true,
          remaining_calls: Math.max(0, maxCalls - calls),
        }),
      );
      return;
    }
    const header = req.headers.authorization ?? '',
      provided = Buffer.from(header.replace(/^Bearer /, '')),
      expected = Buffer.from(token);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      res.writeHead(401);
      res.end('{"code":"UNAUTHORIZED"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/shutdown') {
      res.end('{"stopping":true}');
      setImmediate(() => server.close());
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/generate') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    if (calls >= maxCalls) {
      res.writeHead(429);
      res.end('{"code":"BUDGET_EXHAUSTED"}');
      return;
    }
    let length = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 512 * 1024) throw new Error('INPUT_TOO_LARGE');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !input.task?.id ||
        !input.snapshot?.bound ||
        !['A', 'B'].includes(input.variant ?? 'B') ||
        !Array.isArray(input.snapshot.evidence)
      )
        throw new Error('INVALID_INPUT');
      // The client supplies synthetic task data, never a provider/workspace authority.
      const task = {
        ...input.task,
        id: 'bridge-' + randomUUID(),
        owner_id: owner,
        workspace_id: workspace,
        generations: Math.min(
          2,
          Math.max(1, Number(input.task.generations) || 1),
        ),
      };
      calls++;
      const started = Date.now(),
        controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65000);
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', onClose);
      try {
        const answer = await configuredModel({
          task,
          snapshot: input.snapshot,
          signal: controller.signal,
          variant: input.variant ?? 'B',
          repair: input.repair,
        });
        const usage = {
          ...answer.usage,
          model_ref: answer.usage.model_ref
            ? 'sha256:' + sha(answer.usage.model_ref)
            : null,
        };
        observations.push({
          request: calls,
          task_type: input.snapshot.bound.task_type,
          market: input.snapshot.bound.market,
          variant: input.variant ?? 'B',
          elapsed_ms: Date.now() - started,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cost_usd: null,
          result_hash: sha(answer.text),
          status: 'response_received',
          diagnostics: answer.diagnostics,
        });
        fs.writeFileSync(
          path.join(output, 'summary.json'),
          JSON.stringify(
            {
              configured: true,
              max_calls: maxCalls,
              actual_calls: calls,
              observations,
            },
            null,
            2,
          ),
        );
        res.end(JSON.stringify({ text: answer.text, usage }));
      } finally {
        clearTimeout(timer);
        res.off('close', onClose);
      }
    } catch (error) {
      const code =
        /^(?:MODEL_[A-Z_]+|BUDGET_EXHAUSTED|CANCELLED|CONTEXT_BUDGET_EXHAUSTED)$/.test(
          error?.message ?? '',
        )
          ? error.message
          : 'MODEL_OR_INPUT_UNAVAILABLE';
      const usage = error?.usage
        ? {
            ...error.usage,
            model_ref: error.usage.model_ref
              ? 'sha256:' + sha(error.usage.model_ref)
              : null,
          }
        : null;
      observations.push({
        request: calls,
        status: 'failed',
        code,
        usage,
        diagnostics: error?.diagnostics ?? null,
      });
      if (!res.headersSent) res.writeHead(502);
      res.end(
        JSON.stringify({
          code,
          usage,
          diagnostics: error?.diagnostics ?? null,
        }),
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    path.join(output, 'connection.json'),
    JSON.stringify(
      { bridge: endpoint, token_file: tokenFile, max_calls: maxCalls },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ready: true,
      bridge: endpoint,
      token_file: tokenFile,
      max_calls: maxCalls,
    }),
  );
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      void cleanup().then(() => process.exit(0));
    });
  await once(server, 'close');
} catch {
  console.log(
    JSON.stringify({
      ready: false,
      code: 'PROVIDER_NOT_CONFIGURED_OR_UNAVAILABLE',
    }),
  );
  process.exitCode = 2;
} finally {
  await cleanup();
}
