import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const repository = path.resolve('.');
const demoRoot = path.join(repository, 'artifacts/ecommerce-ops/demos');
const owned: string[] = [];
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/ecommerce-demo.mjs', ...args], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 30_000,
  });
function workspace() {
  const id = `demo-test-${randomUUID()}`;
  owned.push(path.join(demoRoot, id));
  return id;
}
afterEach(() => {
  for (const directory of owned.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(demoRoot + path.sep))
      throw new Error('Unsafe test cleanup');
    if (fs.existsSync(resolved)) {
      if (fs.lstatSync(resolved).isSymbolicLink()) fs.unlinkSync(resolved);
      else fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
});
test('demo rejects production identities, path traversal and unknown scenarios', () => {
  for (const args of [
    ['--workspace', 'production'],
    ['--workspace', '../demo-escape'],
    ['--workspace', 'demo-safe', '--scenario', 'unknown'],
  ]) {
    const result = run(...args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DEMO_(?:WORKSPACE|SCENARIO)/);
  }
});
test('reset refuses an unmarked existing directory without changing its files', () => {
  const id = workspace(),
    directory = path.join(demoRoot, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'foreign.txt'), 'KEEP');
  const result = run('--workspace', id, '--reset');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('DEMO_MARKER_REQUIRED');
  expect(fs.readFileSync(path.join(directory, 'foreign.txt'), 'utf8')).toBe(
    'KEEP',
  );
  expect(fs.existsSync(path.join(directory, '.ecommerce-demo.json'))).toBe(
    false,
  );
});
test('demo refuses junction escapes even when an outside directory has a marker', () => {
  const id = workspace(),
    outside = path.join(demoRoot, `demo-outside-${randomUUID()}`);
  owned.push(outside);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'foreign.txt'), 'KEEP');
  fs.symlinkSync(
    outside,
    path.join(demoRoot, id),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = run('--workspace', id, '--reset');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/DEMO_(?:PATH|SYMLINK)/);
  expect(fs.readFileSync(path.join(outside, 'foreign.txt'), 'utf8')).toBe(
    'KEEP',
  );
});
test('reset rejects a dangling exports junction before creating its target', () => {
  const id = workspace(),
    directory = path.join(demoRoot, id),
    missing = path.join(demoRoot, `demo-missing-${randomUUID()}`);
  owned.push(missing);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, '.ecommerce-demo.json'),
    JSON.stringify({
      application: 'opendot.ecommerce-demo',
      version: 1,
      workspace_id: id,
      directory,
      database: 'demo.sqlite',
    }),
  );
  fs.symlinkSync(
    missing,
    path.join(directory, 'exports'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const result = run('--workspace', id, '--reset');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('DEMO_SYMLINK_REFUSED');
  expect(fs.existsSync(missing)).toBe(false);
  expect(fs.existsSync(path.join(directory, 'demo.sqlite'))).toBe(false);
});
test('check rejects unknown modes and fixture refuses arbitrary backend entries before startup', async () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/ecommerce-check.mjs', 'fake-success'],
    { cwd: repository, encoding: 'utf8' },
  );
  expect(result.status).toBe(2);
  const previous = process.env.OPENDOT_ECOMMERCE_BACKEND_ENTRY;
  process.env.OPENDOT_ECOMMERCE_BACKEND_ENTRY = path.join(
    repository,
    'dist/index.js',
  );
  try {
    const { botHandoffHttpFixture } =
      await import('../helpers/bot-handoff-http-fixture.js');
    await expect(botHandoffHttpFixture()).rejects.toThrow(
      'Invalid isolated Ecommerce backend entry',
    );
  } finally {
    if (previous === undefined)
      delete process.env.OPENDOT_ECOMMERCE_BACKEND_ENTRY;
    else process.env.OPENDOT_ECOMMERCE_BACKEND_ENTRY = previous;
  }
});
test.each(['launch-us-de', 'conflicting-evidence', 'operations-boundaries'])(
  '%s runs actual business quality/export and reopens the same private SQLite',
  (scenario) => {
    const id = workspace();
    const result = run('--workspace', id, '--scenario', scenario, '--reset');
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(
      fs.readFileSync(path.join(demoRoot, id, 'report.json'), 'utf8'),
    );
    expect(report.status).toBe('passed');
    expect(report.model).toBe('synthetic.fixture.v1');
    expect(report.operator).toBe('synthetic.operator');
    expect(report.persistence.reopened).toBe(true);
    expect(report.large_source.raw_bytes).toBeGreaterThan(65_536);
    expect(report.large_source.full_blob_verified).toBe(true);
    expect(report.external_requests).toBe(0);
    expect(
      report.assertions.every((item: { passed: boolean }) => item.passed),
    ).toBe(true);
    expect(report.exports.length).toBeGreaterThan(1);
    const replay = run('--workspace', id, '--scenario', scenario);
    expect(replay.status, replay.stderr).toBe(0);
    const repeated = JSON.parse(
      fs.readFileSync(path.join(demoRoot, id, 'report.json'), 'utf8'),
    );
    expect(repeated.replayed).toBe(true);
    expect(repeated.task_ids).toEqual(report.task_ids);
    expect(repeated.artifact_ids).toEqual(report.artifact_ids);
  },
);
