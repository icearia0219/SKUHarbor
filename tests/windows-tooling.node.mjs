import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(import.meta.dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot windows '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, filename, contents = '') {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

async function loadScript(filename) {
  const target = path.join(repository, 'scripts', filename);
  assert.ok(
    fs.existsSync(target),
    `${filename} must provide the Windows entry point`,
  );
  return import(pathToFileURL(target).href);
}

function runNode(script, root, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('setup invokes locked installs and build through the npm JavaScript CLI', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'container/agent-runner'), { recursive: true });
  const log = path.join(root, 'npm calls.jsonl');
  const npmCli = write(
    root,
    'npm cli.cjs',
    `require('node:fs').appendFileSync(process.env.OPENDOT_TEST_NPM_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');`,
  );
  const { setupWindows } = await loadScript('setup-windows.mjs');
  await setupWindows({
    root,
    env: {
      ...process.env,
      npm_execpath: npmCli,
      LOCALAPPDATA: root,
      OPENDOT_TEST_NPM_LOG: log,
    },
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.args.slice(0, 1)),
    [['ci'], ['ci'], ['ci']],
  );
  assert.deepEqual(
    calls.map((call) => path.relative(root, call.cwd)),
    ['', 'web', path.join('container', 'agent-runner'), ''],
  );
  for (const call of calls.slice(0, 3)) {
    const cacheIndex = call.args.indexOf('--cache');
    assert.ok(cacheIndex > 0);
    assert.ok(fs.statSync(call.args[cacheIndex + 1]).isDirectory());
  }
  assert.deepEqual(calls[3].args, ['run', 'build:all']);
});

test('setup stops before later projects when npm ci fails', async (t) => {
  const root = fixture(t);
  const log = path.join(root, 'npm calls.jsonl');
  const npmCli = write(
    root,
    'failing npm.cjs',
    `require('node:fs').appendFileSync(process.env.OPENDOT_TEST_NPM_LOG, process.cwd() + '\\n'); process.exit(17);`,
  );
  const { setupWindows } = await loadScript('setup-windows.mjs');
  await assert.rejects(
    setupWindows({
      root,
      env: {
        ...process.env,
        npm_execpath: npmCli,
        LOCALAPPDATA: root,
        OPENDOT_TEST_NPM_LOG: log,
      },
    }),
    /17/,
  );
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('Git Bash discovery handles a nonstandard Git installation and rejects a missing override', async (t) => {
  const root = fixture(t);
  const git = write(root, 'Custom Git/cmd/git.exe');
  const bash = write(root, 'Custom Git/bin/bash.exe');
  const { findGitBash } = await loadScript('windows-common.mjs');
  assert.equal(findGitBash({ env: { PATH: path.dirname(git) } }), bash);
  assert.throws(
    () =>
      findGitBash({
        env: { MINICLAW_HOST_BASH_PATH: path.join(root, 'missing.exe') },
      }),
    /MINICLAW_HOST_BASH_PATH/,
  );
});

test('Git Bash discovery does not use the Windows WSL bash launcher', async (t) => {
  const root = fixture(t);
  const launcher = write(root, 'Windows/System32/bash.exe');
  const { findGitBash } = await loadScript('windows-common.mjs');
  assert.equal(findGitBash({ env: { PATH: path.dirname(launcher) } }), null);
  assert.throws(
    () => findGitBash({ env: { MINICLAW_HOST_BASH_PATH: launcher } }),
    /Git for Windows/,
  );
});

test('setup falls back to a project cache when LOCALAPPDATA is not writable', async (t) => {
  const root = fixture(t);
  const blocked = write(root, 'not-a-directory');
  const { writableNpmCache } = await loadScript('windows-common.mjs');
  assert.equal(
    writableNpmCache(root, { LOCALAPPDATA: blocked }),
    path.join(root, '.npm-cache'),
  );
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
});

test(
  'Windows cancellation terminates the owned backend and detached descendants',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = fixture(t);
    const pidFile = path.join(root, 'leaf.pid');
    const leaf = write(
      root,
      'leaf.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const backend = write(
      root,
      'backend.cjs',
      `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore',detached:true,windowsHide:true}); child.unref(); setInterval(() => {}, 1000);`,
    );
    const common = pathToFileURL(
      path.join(repository, 'scripts/windows-common.mjs'),
    ).href;
    const wrapper = write(
      root,
      'wrapper.mjs',
      `import fs from 'node:fs'; import {runNode} from ${JSON.stringify(common)}; const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(ready);process.emit('SIGINT');}},20); process.exitCode=await runNode([${JSON.stringify(backend)}]);`,
    );
    let leafPid;
    try {
      const result = spawnSync(process.execPath, [wrapper], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 130, result.stderr);
      leafPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.throws(() => process.kill(leafPid, 0), { code: 'ESRCH' });
    } finally {
      if (!leafPid && fs.existsSync(pidFile))
        leafPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (leafPid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(leafPid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          /* already reaped */
        }
      }
    }
  },
);

test(
  'Windows backend cancellation reaps its MSYS jobs and preserves another shell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = fixture(t);
    const { findGitBash } = await loadScript('windows-common.mjs');
    const selected = findGitBash();
    assert.ok(
      selected,
      'Git for Windows is required for this native cancellation test',
    );
    const actual = path.resolve(path.dirname(selected), '../usr/bin/bash.exe');
    const bash = fs.existsSync(actual) ? actual : selected;
    const ps = path.join(path.dirname(bash), 'ps.exe');
    const kill = path.join(path.dirname(bash), 'kill.exe');
    const sharedFile = path.join(repository, 'shared/windows-process.cjs');
    const { prepareWindowsBashCommand } = await import(
      pathToFileURL(sharedFile).href
    );
    const ownedInfo = path.join(root, 'owned.json');
    const ownedPidFile = path.join(root, 'owned-msys.pid');
    const parallelPidFile = path.join(root, 'parallel-msys.pid');
    const cancelFile = path.join(root, 'cancel.request');
    const background = (pidFile) =>
      `sleep 30 & printf '%s' "$!" > '${pidFile.replace(/\\/g, '/').replace(/'/g, "'\\''")}'; wait`;
    const backend = write(
      root,
      'backend.mjs',
      `import fs from 'node:fs';import {spawn} from 'node:child_process';import helper from ${JSON.stringify(pathToFileURL(sharedFile).href)};const child=spawn(${JSON.stringify(bash)},['-c',helper.prepareWindowsBashCommand(${JSON.stringify(background(ownedPidFile))})],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(ownedInfo)},JSON.stringify({backend:process.pid,bash:child.pid}));setInterval(()=>{},1000);`,
    );
    const common = pathToFileURL(
      path.join(repository, 'scripts/windows-common.mjs'),
    ).href;
    const wrapperFile = write(
      root,
      'wrapper.mjs',
      `import fs from 'node:fs';import {runNode} from ${JSON.stringify(common)};const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(cancelFile)})){clearInterval(ready);process.emit('SIGINT');}},20);process.exitCode=await runNode([${JSON.stringify(backend)}]);`,
    );
    const parallel = spawn(
      bash,
      ['-c', prepareWindowsBashCommand(background(parallelPidFile))],
      { stdio: 'ignore', windowsHide: true },
    );
    const wrapper = spawn(process.execPath, [wrapperFile], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, MINICLAW_HOST_BASH_PATH: selected },
    });
    const stopped = once(wrapper, 'close');
    let info, ownedJob, parallelJob;
    let deadline;
    const send = (pid, signal) =>
      spawnSync(kill, [`-${signal}`, String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 3_000,
      }).status;
    try {
      const readyUntil = Date.now() + 5_000;
      while (
        Date.now() < readyUntil &&
        (!fs.existsSync(ownedInfo) ||
          !fs.existsSync(ownedPidFile) ||
          !fs.existsSync(parallelPidFile))
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      info = JSON.parse(fs.readFileSync(ownedInfo, 'utf8'));
      const ownPid = Number(fs.readFileSync(ownedPidFile, 'utf8'));
      const otherPid = Number(fs.readFileSync(parallelPidFile, 'utf8'));
      const snapshot = execFileSync(ps, ['-W'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const rows = snapshot.split(/\r?\n/).flatMap((line) => {
        const m = line.match(
          /^\s*(?:[A-Z]\s+)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/,
        );
        return m
          ? [{ pid: Number(m[1]), ppid: Number(m[2]), winpid: Number(m[4]) }]
          : [];
      });
      ownedJob = rows.find((row) => row.pid === ownPid);
      parallelJob = rows.find((row) => row.pid === otherPid);
      const ownedShell = rows.find((row) => row.winpid === info.bash);
      const otherShell = rows.find((row) => row.winpid === parallel.pid);
      assert.ok(ownedJob && ownedShell && parallelJob && otherShell);
      assert.equal(ownedJob.ppid, ownedShell.pid);
      assert.equal(parallelJob.ppid, otherShell.pid);
      fs.writeFileSync(cancelFile, 'cancel this fixture only');
      const [code] = await Promise.race([
        stopped,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Backend wrapper did not stop')),
            12_000,
          );
        }),
      ]);
      assert.equal(code, 130);
      assert.notEqual(
        send(ownedJob.pid, '0'),
        0,
        'the cancelled backend left its ordinary MSYS background job alive',
      );
      assert.throws(() => process.kill(ownedJob.winpid, 0), { code: 'ESRCH' });
      assert.equal(
        send(parallelJob.pid, '0'),
        0,
        'an unrelated parallel shell was cancelled',
      );
    } finally {
      if (deadline) clearTimeout(deadline);
      for (const job of [ownedJob, parallelJob]) if (job) send(job.pid, 'KILL');
      for (const pid of [info?.backend, parallel.pid, wrapper.pid])
        if (pid) {
          try {
            execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            /* fixture already stopped */
          }
        }
    }
  },
);

test('start reports missing builds before launching a backend', async (t) => {
  const root = fixture(t);
  const { startWindows } = await loadScript('start-windows.mjs');
  await assert.rejects(
    startWindows({ root, env: process.env }),
    /setup:windows/,
  );
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
});

test('start passes the chosen Git Bash to the backend from the repository directory', async (t) => {
  const root = fixture(t);
  for (const directory of [
    'node_modules',
    'web/node_modules',
    'container/agent-runner/node_modules',
  ])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  write(root, 'web/dist/index.html', '<!doctype html>');
  write(root, 'container/agent-runner/dist/pi-index.js');
  const output = path.join(root, 'started.json');
  write(
    root,
    'dist/index.js',
    `require('node:fs').writeFileSync(process.env.OPENDOT_TEST_START_OUTPUT, JSON.stringify({cwd:process.cwd(), bash:process.env.MINICLAW_HOST_BASH_PATH}));`,
  );
  const bash = write(root, 'Git/bin/bash.exe');
  const { startWindows } = await loadScript('start-windows.mjs');
  assert.equal(
    await startWindows({
      root,
      env: {
        ...process.env,
        MINICLAW_HOST_BASH_PATH: bash,
        OPENDOT_TEST_START_OUTPUT: output,
      },
    }),
    0,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    cwd: root,
    bash,
  });
});

test('documentation check works in a ZIP tree and ignores generated or private files', (t) => {
  const root = fixture(t);
  write(root, 'README.md', '[Guide](docs/guide.md)\n');
  write(root, 'CLAUDE.md', '# Guide\n');
  write(root, 'docs/guide.md', '# Windows\n');
  write(root, 'docs/API.md', '# API\n');
  write(root, 'Makefile', 'help:\n');
  fs.mkdirSync(path.join(root, 'src/routes'), { recursive: true });
  for (const directory of [
    'node_modules',
    'data',
    'dist',
    '.git',
    'web/node_modules',
    'electron/release',
  ])
    write(root, `${directory}/ignored.md`, '[invalid](missing.md)\n');
  const result = runNode(path.join(repository, 'scripts/check-docs.mjs'), root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 repository Markdown files/);
  write(root, 'docs/guide.md', '[Missing](missing.md)\n');
  const broken = runNode(path.join(repository, 'scripts/check-docs.mjs'), root);
  assert.equal(broken.status, 1);
  assert.match(
    broken.stderr,
    /docs[/\\]guide.md:1 references missing missing.md/,
  );
});

test('format checker executes the Prettier JavaScript entry without a shell shim', (t) => {
  const root = fixture(t);
  const script = write(
    root,
    'scripts/check-format-changed.mjs',
    fs.readFileSync(path.join(repository, 'scripts/check-format-changed.mjs')),
  );
  write(root, 'package.json', '{"type":"module"}\n');
  write(
    root,
    'node_modules/prettier/package.json',
    '{"name":"prettier","bin":{"prettier":"bin/prettier.cjs"}}\n',
  );
  write(
    root,
    'node_modules/prettier/bin/prettier.cjs',
    'console.log("PRETTIER_JS_ENTRY", JSON.stringify(process.argv.slice(2)));\n',
  );
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'example.ts', 'export const example = 1;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  const result = runNode(script, root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PRETTIER_JS_ENTRY/);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /example.ts/);
});
