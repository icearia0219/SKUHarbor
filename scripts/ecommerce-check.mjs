#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const repository = fs.realpathSync(
  fileURLToPath(new URL('../', import.meta.url)),
);
const [mode, ...extra] = process.argv.slice(2);
const modes = ['unit', 'integration', 'types', 'build', 'e2e', 'docs', 'all'];
if (mode === '--help') {
  console.log(
    'node scripts/ecommerce-check.mjs unit|integration|types|build|e2e|docs|all',
  );
  process.exit(0);
}
if (!modes.includes(mode) || extra.length) {
  console.error('ECOMMERCE_CHECK_MODE_REQUIRED: ' + modes.join('|'));
  process.exit(2);
}
const checksRoot = path.join(repository, 'artifacts/ecommerce-ops/checks');
let ancestor = repository;
for (const segment of path.relative(repository, checksRoot).split(path.sep)) {
  ancestor = path.join(ancestor, segment);
  if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error('CHECK_OUTPUT_SYMLINK_REFUSED');
}
const output = path.join(
  checksRoot,
  `check-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
fs.mkdirSync(output, { recursive: true });
const report = {
  mode,
  status: 'running',
  output,
  started_at: new Date().toISOString(),
  steps: [],
};
const reportFile = path.join(output, 'report.json');
const save = () =>
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
save();
async function run(name, command, args, cwd = repository, env = {}) {
  const logPath = path.join(
    output,
    `${String(report.steps.length + 1).padStart(2, '0')}-${name}.log`,
  );
  const step = {
    name,
    command: [command, ...args],
    cwd,
    started_at: new Date().toISOString(),
    log: path.relative(output, logPath),
    exit_code: null,
  };
  report.steps.push(step);
  save();
  console.log(`[ecommerce-check] ${name}`);
  const log = fs.openSync(logPath, 'w');
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (part) => {
        fs.writeSync(log, part);
        process.stdout.write(part);
      });
      child.stderr.on('data', (part) => {
        fs.writeSync(log, part);
        process.stderr.write(part);
      });
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    step.exit_code = code;
    step.finished_at = new Date().toISOString();
    save();
    if (code !== 0) throw new Error(`CHECK_FAILED:${name}:${code}`);
  } catch (error) {
    step.exit_code ??= 1;
    step.finished_at = new Date().toISOString();
    save();
    throw error;
  } finally {
    fs.closeSync(log);
  }
}
const node = (name, args, cwd, env) =>
  run(name, process.execPath, args, cwd, env);
const tsc = (project, args = []) =>
  node(
    `types-${project.replaceAll('/', '-')}`,
    [
      path.join(repository, project, 'node_modules/typescript/bin/tsc'),
      '--incremental',
      'false',
      '--noEmit',
      ...args,
    ],
    path.join(repository, project),
  );
async function types() {
  await tsc('.');
  await node('types-personal-agent', [
    'node_modules/typescript/bin/tsc',
    '-p',
    'tsconfig.personal-agent.json',
  ]);
  await tsc('web');
  await tsc('container/agent-runner');
  await node('types-e2e', [
    'web/node_modules/typescript/bin/tsc',
    '-p',
    'web/tsconfig.e2e.json',
    '--incremental',
    'false',
  ]);
}
async function tests(integration) {
  const files = fs
    .readdirSync(path.join(repository, 'tests/ecommerce-ops'))
    .filter((name) => /\.test\.tsx?$/.test(name));
  const isIntegration = (name) =>
    /\.integration\.test\./.test(name) ||
    /api|workflow|security|review|domain|benchmark|budget|demo|cli/.test(name);
  const selected = files
    .filter((name) => isIntegration(name) === integration)
    .map((name) => 'tests/ecommerce-ops/' + name);
  if (!integration) selected.push('web/src/components/ecommerce-ops');
  if (!selected.length) throw new Error('CHECK_EMPTY_TEST_SELECTION');
  await node(integration ? 'integration' : 'unit', [
    'scripts/run-node-cli.mjs',
    'vitest',
    'run',
    '--config',
    'vitest.ecommerce.config.ts',
    '--configLoader',
    'native',
    '--no-cache',
    ...selected,
  ]);
}
async function viteBuild(outDir) {
  // Load the actual web config without bundler temp files. Preserve its legacy __dirname value.
  const oldDirname = globalThis.__dirname;
  globalThis.__dirname = path.join(repository, 'web');
  try {
    const { build } =
      await import('../web/node_modules/vite/dist/node/index.js');
    await build({
      root: path.join(repository, 'web'),
      configFile: path.join(repository, 'web/vite.config.ts'),
      configLoader: 'native',
      cacheDir: path.join(output, 'vite-cache'),
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (oldDirname === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = oldDirname;
  }
}
async function recordVite(name, outDir) {
  const step = {
    name,
    command:
      'Actual Vite build API using web/vite.config.ts with native loader',
    out_dir: outDir,
    started_at: new Date().toISOString(),
    exit_code: null,
  };
  report.steps.push(step);
  save();
  try {
    await viteBuild(outDir);
    step.exit_code = 0;
  } catch (error) {
    step.exit_code = 1;
    throw error;
  } finally {
    step.finished_at = new Date().toISOString();
    save();
  }
}
async function build() {
  await node('build-root', [
    'node_modules/typescript/bin/tsc',
    '--incremental',
    'false',
  ]);
  await tsc('web');
  await recordVite('build-web', path.join(repository, 'web/dist'));
  await node(
    'build-runner',
    ['node_modules/typescript/bin/tsc', '--incremental', 'false'],
    path.join(repository, 'container/agent-runner'),
  );
}
async function e2e() {
  const isolated = path.join(output, 'isolated');
  fs.mkdirSync(isolated);
  fs.writeFileSync(
    path.join(isolated, 'package.json'),
    JSON.stringify({
      name: 'opendot-isolated-ecommerce-check',
      type: 'module',
    }) + '\n',
  );
  // Keep source-adjacent runtime assets available to the isolated compilation.
  // These links are consumed read-only; backend state stays in the fixture's private cwd.
  for (const directory of ['docs', 'shared'])
    fs.symlinkSync(
      path.join(repository, directory),
      path.join(isolated, directory),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  const backend = path.join(isolated, 'backend');
  await node('e2e-build-backend', [
    'node_modules/typescript/bin/tsc',
    '--incremental',
    'false',
    '--outDir',
    backend,
  ]);
  await tsc('web');
  const web = path.join(isolated, 'web-dist');
  await recordVite('e2e-build-web', web);
  await node(
    'e2e-browser',
    [
      '../scripts/run-node-cli.mjs',
      'playwright',
      'test',
      '--config',
      'playwright.ecommerce.config.ts',
      '--output',
      path.join(output, 'browser'),
    ],
    path.join(repository, 'web'),
    {
      OPENDOT_ECOMMERCE_BACKEND_ENTRY: path.join(backend, 'index.js'),
      OPENDOT_ECOMMERCE_WEB_DIST: web,
    },
  );
}
try {
  if (mode === 'types' || mode === 'all') await types();
  if (mode === 'unit' || mode === 'all') await tests(false);
  if (mode === 'integration' || mode === 'all') await tests(true);
  if (mode === 'build' || mode === 'all') await build();
  if (mode === 'e2e' || mode === 'all') await e2e();
  if (mode === 'docs' || mode === 'all')
    await node('docs', ['scripts/check-docs.mjs']);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.message);
  process.exitCode = 1;
  console.error('[ecommerce-check] ' + report.error);
} finally {
  report.finished_at = new Date().toISOString();
  save();
  console.log(`[ecommerce-check] ${report.status}: ${reportFile}`);
}
