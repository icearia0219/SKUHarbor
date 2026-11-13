import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readBridgeToken,
  validateBridgeUrl,
} from '../benchmarks/ecommerce-ops/bridge.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url)),
  args = process.argv.slice(2),
  get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i < 0 ? fallback : args[i + 1];
  };
const manifestPath = path.resolve(
    get(
      '--manifest',
      path.join(repository, 'benchmarks/ecommerce-ops/manifest.json'),
    ),
  ),
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const suite = get('--suite', 'test'),
  variant = get('--variant', 'B'),
  model = get('--model', 'none'),
  mode =
    model === 'fixture'
      ? 'contract_smoke'
      : model === 'configured'
        ? 'model'
        : 'engineering';
const output = path.resolve(
  get(
    '--output',
    path.join(repository, 'artifacts/ecommerce-ops/evals', `run-${Date.now()}`),
  ),
);
if (
  !['dev', 'validation', 'test', 'all', 'faults'].includes(suite) ||
  !['A', 'B', 'C'].includes(variant) ||
  !['none', 'fixture', 'configured'].includes(model)
)
  throw new Error('Unsupported suite, variant or model');
if (model === 'configured' && variant === 'C')
  throw new Error('CONFIGURED_VARIANT_A_OR_B_REQUIRED');
if (fs.existsSync(path.join(output, 'run.json')))
  throw new Error('Output already contains a run; use a new output directory');
const requestedCases = get('--case', '').split(',').filter(Boolean);
const selected = manifest.entries.filter(
  (e) =>
    (suite === 'all' || e.split === suite) &&
    (!requestedCases.length || requestedCases.includes(e.id)),
);
if (requestedCases.some((id) => !selected.some((entry) => entry.id === id)))
  throw new Error('Requested case is not in the selected frozen suite');
const requestedBridge = get('--bridge', null),
  tokenFile = get('--bridge-token-file', null);
if ((requestedBridge !== null || tokenFile !== null) && model !== 'configured')
  throw new Error('Bridge flags require --model configured');
if ((requestedBridge === null) !== (tokenFile === null))
  throw new Error('BRIDGE_URL_AND_TOKEN_FILE_REQUIRED');
const bridgeUrl = requestedBridge ? validateBridgeUrl(requestedBridge) : null;
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (hash(JSON.stringify(manifest.entries)) !== manifest.freeze_sha256)
  throw new Error('Manifest freeze digest mismatch');
for (const entry of selected) {
  const file = path.resolve(path.dirname(manifestPath), entry.input);
  if (
    !file.startsWith(path.dirname(manifestPath) + path.sep) ||
    hash(fs.readFileSync(file)) !== entry.input_sha256
  )
    throw new Error(`Input hash/path mismatch: ${entry.id}`);
}
fs.mkdirSync(output, { recursive: true });
const run = {
  run_id: randomUUID(),
  created_at: new Date().toISOString(),
  dataset: manifest.dataset,
  dataset_revision: manifest.dataset_revision ?? manifest.version,
  freeze_sha256: manifest.freeze_sha256,
  variant,
  suite,
  mode,
  model,
  data_status: 'controlled_fixture',
  human_review: 'not_reviewed',
  cases: selected.length,
  budget: manifest.budget,
  ab_comparable: model === 'configured' && !!bridgeUrl,
  real_model_ab_completed: false,
  price_status: 'unknown',
  price_version: null,
  configured_provider_bridge: bridgeUrl ? 'configured' : 'not_configured',
  baseline_definition:
    'A single plain prompt plus shared final schema/quality check; B task SOP plus the same final check',
  bridge_origin_sha256: bridgeUrl ? hash(bridgeUrl) : null,
  code_versions: Object.fromEntries(
    [
      'src/ecommerce-ops/service.ts',
      'src/ecommerce-ops/workflow.ts',
      'src/ecommerce-ops/model.ts',
      'src/ecommerce-ops/knowledge.ts',
      'src/ecommerce-ops/contracts.ts',
      'src/ecommerce-ops/quality.ts',
      'src/ecommerce-ops/metrics.ts',
      'src/ecommerce-ops/reports.ts',
      'src/ecommerce-ops/tasks/support.ts',
      'benchmarks/ecommerce-ops/worker.mjs',
      'benchmarks/ecommerce-ops/materialize.mjs',
      'benchmarks/ecommerce-ops/bridge.mjs',
      'benchmarks/ecommerce-ops/score.mjs',
    ].map((file) => [file, hash(fs.readFileSync(path.join(repository, file)))]),
  ),
  prompt_versions: Object.fromEntries(
    ['research', 'listing', 'ad-copy', 'ads-diagnosis', 'support'].flatMap(
      (name) => {
        const file = path.join(
          repository,
          'docs/ecommerce-ops/prompts',
          name + '.md',
        );
        return fs.existsSync(file) ? [[name, hash(fs.readFileSync(file))]] : [];
      },
    ),
  ),
  permission_policy:
    'evaluated worker: source/dependencies/contracts + current inputs/scratch only; no private labels or original user data',
};
fs.writeFileSync(
  path.join(output, 'run.json'),
  JSON.stringify(run, null, 2) + '\n',
);
if (args.includes('--dry-run')) {
  fs.writeFileSync(
    path.join(output, 'dry-run.json'),
    JSON.stringify(
      {
        ...run,
        credentials_required: model === 'configured',
        model_calls: 0,
        max_model_calls: selected.length * manifest.budget.max_generations,
        estimated_cost_usd: null,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      dry_run: true,
      cases: selected.length,
      model_calls: 0,
      credentials_required: model === 'configured',
      estimated_cost_usd: null,
    }) + '\n',
  );
  process.exit(0);
}
// The parent alone reads this file. It is never copied into worker scratch or logs.
let bridgeToken = null;
if (bridgeUrl) {
  try {
    bridgeToken = readBridgeToken(tokenFile);
  } catch {
    fs.writeFileSync(
      path.join(output, 'failure.json'),
      JSON.stringify({ reason: 'BRIDGE_TOKEN_FILE_INVALID' }),
    );
    process.stderr.write('BRIDGE_TOKEN_FILE_INVALID\n');
    process.exit(2);
  }
}
if (suite === 'faults') {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repository, 'scripts/run-node-cli.mjs'),
      'vitest',
      'run',
      '--config',
      path.join(repository, 'vitest.ecommerce.config.ts'),
      path.join(repository, 'tests/ecommerce-ops'),
      '--reporter=json',
      `--outputFile=${path.join(output, 'fault-tests.json')}`,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(output, 'fault-tests.log'),
    result.stdout + '\n' + result.stderr,
  );
  if (!fs.existsSync(path.join(output, 'fault-tests.json'))) {
    fs.writeFileSync(
      path.join(output, 'failure.json'),
      JSON.stringify({
        reason: 'FAULT_TEST_RUNNER_FAILED',
        exit: result.status,
        error: result.error?.code ?? null,
      }),
    );
    process.exit(2);
  }
  const raw = JSON.parse(
    fs.readFileSync(path.join(output, 'fault-tests.json'), 'utf8'),
  );
  const assertions = raw.testResults.flatMap((t) =>
    t.assertionResults.map((a) => ({
      ...a,
      file: path.relative(repository, t.name),
    })),
  );
  const mapping = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'benchmarks/ecommerce-ops/faults.json'),
      'utf8',
    ),
  );
  const rows = mapping.cases.map((f) => {
    const requirements = f.requirements.map((pattern) => {
      const matched = assertions.filter((a) =>
        new RegExp(pattern, 'i').test(a.fullName),
      );
      return {
        pattern,
        passed:
          matched.length > 0 && matched.every((a) => a.status === 'passed'),
        matched: matched.map((a) => ({
          name: a.fullName,
          status: a.status,
          file: a.file,
        })),
      };
    });
    return {
      ...f,
      status:
        f.coverage === 'complete' && requirements.every((r) => r.passed)
          ? 'passed'
          : 'unverified',
      requirements,
    };
  });
  fs.writeFileSync(
    path.join(output, 'faults.json'),
    JSON.stringify(
      { run, ...raw, testResults: undefined, cases: rows },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      faults: rows.length,
      passed: rows.filter((r) => r.status === 'passed').length,
      unverified: rows.filter((r) => r.status !== 'passed').length,
    }) + '\n',
  );
  process.exit(
    result.status === 0 && rows.every((r) => r.status === 'passed') ? 0 : 1,
  );
}
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'opendot-ecommerce-benchmark-'),
);
try {
  const input = path.join(scratch, 'inputs.json'),
    observation = path.join(scratch, 'observations.json');
  const visibleInputs = selected.map((e) =>
    JSON.parse(
      fs.readFileSync(path.join(path.dirname(manifestPath), e.input), 'utf8'),
    ),
  );
  fs.writeFileSync(input, JSON.stringify(visibleInputs));
  const worker = path.join(repository, 'benchmarks/ecommerce-ops/worker.mjs');
  const permissions = [
    '--permission',
    '--allow-addons',
    '--allow-worker',
    `--allow-fs-read=${scratch}`,
    `--allow-fs-write=${scratch}`,
    ...[
      'src',
      'node_modules',
      'package.json',
      'docs/ecommerce-ops/contracts',
    ].map((p) => `--allow-fs-read=${path.join(repository, p)}`),
    `--allow-fs-read=${worker}`,
    `--allow-fs-read=${path.join(repository, 'benchmarks/ecommerce-ops/materialize.mjs')}`,
    `--allow-fs-read=${path.join(repository, 'benchmarks/ecommerce-ops/bridge.mjs')}`,
  ];
  const child = spawnSync(
    process.execPath,
    [
      ...permissions,
      '--import',
      pathToImport(repository),
      worker,
      input,
      observation,
      repository,
      mode,
      variant,
      path.join(path.dirname(manifestPath), 'private/gold.canary'),
    ],
    {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: scratch,
        TMP: scratch,
        TSX_DISABLE_CACHE: '1',
        NODE_NO_WARNINGS: '1',
        ...(bridgeUrl
          ? {
              OPENDOT_BENCH_BRIDGE_URL: bridgeUrl,
              OPENDOT_BENCH_BRIDGE_TOKEN: bridgeToken,
            }
          : {}),
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout:
        model === 'configured'
          ? Math.max(
              180000,
              selected.length * manifest.budget.max_elapsed_ms + 30000,
            )
          : 180000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(output, 'worker.log'),
    child.stdout + '\n' + child.stderr,
  );
  if (child.status !== 0 || !fs.existsSync(observation)) {
    fs.writeFileSync(
      path.join(output, 'failure.json'),
      JSON.stringify(
        {
          reason: 'ISOLATED_WORKER_FAILED',
          exit: child.status,
          error: child.error?.code ?? null,
        },
        null,
        2,
      ),
    );
    process.stderr.write(child.stderr.slice(-1800));
    process.exitCode = 2;
  } else {
    const destination = path.join(output, 'observations.json');
    fs.copyFileSync(observation, destination);
    const scored = spawnSync(
      process.execPath,
      [
        path.join(repository, 'benchmarks/ecommerce-ops/score.mjs'),
        manifestPath,
        destination,
        path.join(output, 'report.json'),
      ],
      {
        cwd: scratch,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(output, 'score.log'),
      scored.stdout + '\n' + scored.stderr,
    );
    process.stdout.write(scored.stdout);
    process.stderr.write(scored.stderr);
    process.exitCode = scored.status ?? 2;
    if (model === 'configured' && !bridgeUrl) {
      process.stdout.write(
        'Configured model evaluation is blocked until an authorized workspace/provider bridge and spending budget are supplied.\n',
      );
      process.exitCode = 2;
    }
  }
} finally {
  if (
    path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith('opendot-ecommerce-benchmark-')
  )
    throw new Error('Refusing cleanup outside benchmark scratch');
  fs.rmSync(scratch, { recursive: true, force: true });
}
function pathToImport(root) {
  return pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs'))
    .href;
}
