import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-ecommerce-t11-regression-')),
);
const logFile = path.join(
  repository,
  'artifacts/ecommerce-ops/t11/regression.log',
);
let output = '';
let result = 1;
try {
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'tests/helpers'), { recursive: true });
  for (const name of [
    'db-upgrade-safety',
    'db-transactions',
    'personal-goal-store',
    'product-approval',
    'follow-up-queue-db',
    'goal-context',
    'queue-control-wire',
  ])
    fs.copyFileSync(
      path.join(repository, 'tests', name + '.test.ts'),
      path.join(root, 'tests', name + '.test.ts'),
    );
  fs.copyFileSync(
    path.join(repository, 'tests/helpers/legacy-bot-schema.ts'),
    path.join(root, 'tests/helpers/legacy-bot-schema.ts'),
  );
  fs.copyFileSync(
    path.join(repository, 'package.json'),
    path.join(root, 'package.json'),
  );
  for (const directory of ['src', 'shared', 'container', 'node_modules'])
    fs.symlinkSync(
      path.join(repository, directory),
      path.join(root, directory),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  const child = spawn(
    process.execPath,
    [
      path.join(repository, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      path.join(
        repository,
        'artifacts/ecommerce-ops/t11/regression.config.mjs',
      ),
    ],
    {
      cwd: root,
      windowsHide: true,
      env: {
        ...Object.fromEntries(
          ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        LOCALAPPDATA: path.join(root, 'home/AppData/Local'),
        OPENDOT_T11_SAFE_CWD: root,
        PLUGIN_AUTO_SCAN: 'false',
        TZ: 'UTC',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (part) => {
      output += part.toString();
    });
  result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, output);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), root);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !path.basename(root).startsWith('opendot-ecommerce-t11-regression-')
  )
    throw new Error(
      'Refusing cleanup outside the owned temporary regression root',
    );
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}
process.stdout.write(
  output.split(/\r?\n/).slice(-70).join('\n') +
    '\nREGRESSION_EXIT=' +
    result +
    '\n',
);
process.exitCode = result;
