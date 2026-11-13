import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import ts from 'typescript';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-ecommerce-t11-')),
);
const primary = path.join(root, 'primary');
const restored = path.join(root, 'restored');
const baselineFile = path.join(root, 'baseline-v107.mjs');
const worker = path.join(
  repository,
  'tests/helpers/ecommerce-persistence-worker.mjs',
);
const baseline = '28c3204dce2d85830402b1ef1b6f1f90c6f40f99';
const receipts = path.join(
  repository,
  'artifacts/ecommerce-ops/t11',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
let receiptIndex = 0;

function childEnvironment(cwd: string, feature = true): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]!]),
    ),
    HOME: path.join(cwd, 'home'),
    USERPROFILE: path.join(cwd, 'home'),
    LOCALAPPDATA: path.join(cwd, 'home/AppData/Local'),
    PLUGIN_AUTO_SCAN: 'false',
    OPENDOT_ECOMMERCE_OPS: String(feature),
    MINICLAW_PERSONAL_GOALS: 'true',
    MINICLAW_DEMO_OPEN_SESSION: 'false',
    TZ: 'UTC',
    NODE_NO_WARNINGS: '1',
  };
}
async function run(
  action: string,
  cwd = primary,
  args: string[] = [],
  feature = true,
): Promise<any> {
  const result = await execute(
    process.execPath,
    [worker, action, baselineFile, ...args],
    {
      cwd,
      env: childEnvironment(cwd, feature),
      windowsHide: true,
      timeout: 40_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const line = result.stdout
    .split(/\r?\n/)
    .find((value) => value.startsWith('T11_RESULT '));
  if (!line)
    throw new Error(
      'Owned persistence worker did not produce its result receipt',
    );
  const receipt = JSON.parse(line.slice('T11_RESULT '.length));
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(
    path.join(
      receipts,
      `${String(++receiptIndex).padStart(2, '0')}-${action}.json`,
    ),
    JSON.stringify(receipt, null, 2),
  );
  return receipt;
}

beforeAll(async () => {
  for (const directory of [primary, restored])
    fs.mkdirSync(path.join(directory, 'home'), { recursive: true });
  await execute(
    process.execPath,
    [
      path.join(repository, 'node_modules/typescript/bin/tsc'),
      '--project',
      path.join(repository, 'tsconfig.json'),
      '--incremental',
      'false',
    ],
    {
      cwd: repository,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const original = (
    await execute('git', ['show', `${baseline}:src/db.ts`], {
      cwd: repository,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
  expect(original).toMatch(/CURRENT_SCHEMA_VERSION\s*=\s*107/);
  const emitted = ts.transpileModule(original, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'db.ts',
  }).outputText;
  // Only the historical database entry is transpiled. Its unchanged imports use
  // the current compiled dependency modules; no binary or schema number is edited.
  const linked = emitted.replace(
    /(from\s+|import\s*\()(['"])(\.[^'"]+)\2/g,
    (_all, prefix: string, quote: string, specifier: string) =>
      `${prefix}${quote}${pathToFileURL(path.resolve(repository, 'dist', specifier)).href}${quote}`,
  );
  fs.writeFileSync(baselineFile, linked);
}, 150_000);

afterAll(() => {
  const temporary = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(root);
  const relative = path.relative(temporary, resolved);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(resolved).startsWith('opendot-ecommerce-t11-')
  )
    throw new Error('Refusing cleanup outside the owned T11 fixture');
  fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
});

it('migrates real v107 with a private backup, reopens v108 business data, restores BLOB/hash references and refuses binary downgrade', async () => {
  const old = await run('seed107');
  expect(old.schema).toBe(107);
  expect(old.ecommerce_tables).toBe(0);
  const migration = await run('migrate108');
  expect(migration.schema).toBe(108);
  expect(migration.legacy_message).toBe(
    'Existing v107 conversation survives upgrade',
  );
  expect(migration.backup.schema).toBe(107);
  expect(migration.backup.ecommerce_tables).toBe(0);
  expect(migration.backup.legacy_message).toBe(migration.legacy_message);
  expect(migration.backup.quick_check).toBe('ok');
  expect(migration.backup.private_permissions_verified).toBe(true);
  const seeded = await run('seed-business');
  expect(seeded.raw_bytes).toBeGreaterThan(64 * 1024);
  expect(seeded.artifacts).toHaveLength(2);
  expect(
    seeded.artifacts.some(
      (value: any) => value.stale && value.review_valid === false,
    ),
  ).toBe(true);
  expect(
    seeded.artifacts.some(
      (value: any) => !value.stale && value.review_valid === true,
    ),
  ).toBe(true);
  const reopened = await run('verify-business');
  expect(reopened.digest).toBe(seeded.digest);
  expect(reopened.goal_reference_valid).toBe(true);
  expect(reopened.source_hash_valid).toBe(true);
  expect(reopened.dependency_references_valid).toBe(true);
  const backupFile = path.join(primary, 'data/db/business-backup.db');
  const backup = await run('backup', primary, [backupFile]);
  expect(backup.quick_check).toBe('ok');
  expect(backup.private_permissions_verified).toBe(true);
  // Let the existing application bootstrap a private Windows data directory
  // before restoring. A public manually created data/db is correctly rejected.
  expect((await run('prepare-restore', restored)).schema).toBe(108);
  fs.copyFileSync(backupFile, path.join(restored, 'data/db/messages.db'));
  const recovered = await run('verify-business', restored);
  expect(recovered.digest).toBe(seeded.digest);
  expect(recovered.goal_reference_valid).toBe(true);
  expect(recovered.source_hash_valid).toBe(true);
  expect(recovered.dependency_references_valid).toBe(true);
  const guard = await run('refuse107');
  expect(guard.refused).toBe(true);
  expect(guard.message).toMatch(/schema v108.*newer.*v107.*refusing downgrade/);
  expect(guard.database_unchanged).toBe(true);
  expect((await run('verify-business')).digest).toBe(seeded.digest);
}, 120_000);

it('rolls back by disabling the feature while actual auth, chat and Goal routes retain their data', async () => {
  const result = await run('flag-off', primary, [], false);
  expect(result.statuses).toEqual({
    auth: 200,
    anonymous_auth: 401,
    chat: 200,
    goals: 200,
    availability: 200,
    ecommerce_write: 404,
  });
  expect(result.feature_enabled).toBe(false);
  expect(result.chat_preserved).toBe(true);
  expect(result.goal_preserved).toBe(true);
  expect(result.schema).toBe(108);
  expect(result.business_unchanged).toBe(true);
}, 60_000);
