import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, test, vi } from 'vitest';
import {
  killHostProcessTree,
  prepareHostBashCommand,
  resolveHostBashPath,
} from '../src/host-platform.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-background-'));
const groups = path.join(root, 'groups');
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });
vi.mock('../src/config.js', () => ({ GROUPS_DIR: groups }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ containerTimeout: 30_000 }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function backgroundCommand(pidFile: string): string {
  const target = pidFile.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return `sleep 30 & printf '%s' "$!" > '${target}'`;
}

async function readBackgroundPid(pidFile: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const pid = fs.readFileSync(pidFile, 'utf8').trim();
      if (/^\d+$/.test(pid)) return pid;
    } catch {
      /* Bash has not published the PID yet. */
    }
    await delay(20);
  }
  throw new Error('Background fixture did not start');
}

function bashKill(pid: string, signal: '0' | 'KILL'): number | null {
  return spawnSync(
    resolveHostBashPath()!,
    ['-c', `kill -${signal} ${pid} 2>/dev/null`],
    { windowsHide: true, stdio: 'ignore', timeout: 3_000 },
  ).status;
}

async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Cancellation left an ordinary Bash background job running',
              ),
            ),
          3_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(process.platform !== 'win32')(
  'ordinary Windows Bash background jobs',
  () => {
    test('the public host cancellation entry point reaps a native Node child Bash job', async () => {
      const bash = resolveHostBashPath()!;
      const pidFile = path.join(root, 'native-node.pid');
      const shellFile = path.join(root, 'native-shell.pid');
      const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');const bash=spawn(${JSON.stringify(bash)},['-c',${JSON.stringify(prepareHostBashCommand(backgroundCommand(pidFile)))}],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(shellFile)},String(bash.pid));setInterval(()=>{},1000);`;
      const parent = spawn(process.execPath, ['-e', program], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const closed = once(parent, 'close');
      let pid: string | undefined;
      try {
        pid = await readBackgroundPid(pidFile);
        const shellWinPid = Number(fs.readFileSync(shellFile, 'utf8'));
        const snapshot = spawnSync(
          path.join(path.dirname(bash), 'ps.exe'),
          ['-W'],
          { encoding: 'utf8', windowsHide: true },
        );
        const rows = snapshot.stdout.split(/\r?\n/).flatMap((line) => {
          const m = line.match(
            /^\s*(?:[A-Z]\s+)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/,
          );
          return m
            ? [{ pid: Number(m[1]), ppid: Number(m[2]), winpid: Number(m[4]) }]
            : [];
        });
        const shell = rows.find((row) => row.winpid === shellWinPid);
        const job = rows.find((row) => row.pid === Number(pid));
        expect(shell).toBeTruthy();
        expect(job?.ppid).toBe(shell!.pid);
        expect(killHostProcessTree(parent)).toBe(true);
        await withinDeadline(closed);
        expect(bashKill(pid, '0')).not.toBe(0);
      } finally {
        if (pid) bashKill(pid, 'KILL');
        if (parent.exitCode === null && parent.signalCode === null)
          killHostProcessTree(parent);
        await closed;
      }
    }, 10_000);

    test('preserves command output and a failing exit status while waiting for jobs', async () => {
      const { runScript } = await import('../src/script-runner.js');
      expect(
        await runScript(
          'sleep 0.1 & printf background-done; exit 7',
          'workspace',
        ),
      ).toMatchObject({
        stdout: 'background-done',
        stderr: '',
        exitCode: 7,
        aborted: false,
        timedOut: false,
      });
    });

    test('script abort closes inherited pipes and terminates the background job', async () => {
      const { runScript, getActiveScriptCount } =
        await import('../src/script-runner.js');
      const controller = new AbortController();
      const pidFile = path.join(root, 'script.pid');
      const pending = runScript(backgroundCommand(pidFile), 'workspace', {
        signal: controller.signal,
      });
      let pid: string | undefined;
      try {
        pid = await readBackgroundPid(pidFile);
        // Allow an unprotected Bash to exit, leaving only its inherited pipes open.
        await delay(150);
        controller.abort();
        const result = await withinDeadline(pending);
        expect(result).toMatchObject({
          aborted: true,
          timedOut: false,
          exitCode: null,
        });
        expect(getActiveScriptCount()).toBe(0);
        expect(bashKill(pid, '0')).not.toBe(0);
      } finally {
        if (pid) bashKill(pid, 'KILL');
        controller.abort();
        await pending;
      }
    }, 10_000);

    test('plugin timeout closes inherited pipes and terminates the background job', async () => {
      const { executeInlineBashHost } =
        await import('../src/plugin-inline-bash.js');
      const pidFile = path.join(root, 'plugin.pid');
      const pending = executeInlineBashHost(
        backgroundCommand(pidFile),
        [],
        { CLAUDE_PLUGIN_ROOT: root, ARGUMENTS: '' },
        root,
        { timeoutMs: 1_000, killGraceMs: 100 },
      );
      let pid: string | undefined;
      try {
        pid = await readBackgroundPid(pidFile);
        const result = await withinDeadline(pending);
        expect(result).toMatchObject({ ok: false, timedOut: true });
        expect(bashKill(pid, '0')).not.toBe(0);
      } finally {
        if (pid) bashKill(pid, 'KILL');
        await pending;
      }
    }, 10_000);

    test('cancelling one shell leaves another shell background job alive', async () => {
      const { runScript } = await import('../src/script-runner.js');
      const first = new AbortController();
      const second = new AbortController();
      const firstPidFile = path.join(root, 'first-owned.pid');
      const secondPidFile = path.join(root, 'second-owned.pid');
      const firstRun = runScript(backgroundCommand(firstPidFile), 'workspace', {
        signal: first.signal,
      });
      const secondRun = runScript(
        backgroundCommand(secondPidFile),
        'workspace',
        { signal: second.signal },
      );
      let firstPid: string | undefined;
      let secondPid: string | undefined;
      try {
        [firstPid, secondPid] = await Promise.all([
          readBackgroundPid(firstPidFile),
          readBackgroundPid(secondPidFile),
        ]);
        first.abort();
        expect(await withinDeadline(firstRun)).toMatchObject({ aborted: true });
        expect(bashKill(secondPid, '0')).toBe(0);
        second.abort();
        expect(await withinDeadline(secondRun)).toMatchObject({
          aborted: true,
        });
      } finally {
        first.abort();
        second.abort();
        if (firstPid) bashKill(firstPid, 'KILL');
        if (secondPid) bashKill(secondPid, 'KILL');
        await Promise.all([firstRun, secondRun]);
      }
    }, 10_000);
  },
);
