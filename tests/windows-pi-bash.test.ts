import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveHostBashPath } from '../src/host-platform.js';
import { createWindowsBashOperations } from '../container/agent-runner/src/runtime/pi/windows-bash.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-pi-bash-'));
  roots.push(root);
  const shell = resolveHostBashPath();
  expect(shell).toBeTruthy();
  return { root, shell: shell!, pidFile: path.join(root, 'background.pid') };
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function command(pidFile: string) {
  const quoted = pidFile.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return `sleep 30 & printf '%s' "$!" > '${quoted}'`;
}
async function waitForPid(pidFile: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const value = fs.readFileSync(pidFile, 'utf8').trim();
      if (/^\d+$/.test(value)) return value;
    } catch {
      /* the fixture has not published its PID yet */
    }
    await delay(20);
  }
  throw new Error('The background fixture did not start');
}
function signalFixture(shell: string, pid: string, signal: '0' | 'KILL') {
  return spawnSync(shell, ['-c', `kill -${signal} ${pid} 2>/dev/null`], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 3000,
  }).status;
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Windows Bash cancellation did not settle')),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(process.platform !== 'win32')(
  'Windows Pi Bash operations',
  () => {
    test('preserves cwd, environment, streamed output and a failing exit status', async () => {
      const f = fixture();
      let output = '';
      const result = await createWindowsBashOperations(f.shell).exec(
        `printf '%s' "$WINDOWS_PI_TEST_VALUE"; pwd -W; printf fixture-stderr >&2; exit 7`,
        f.root,
        {
          env: {
            ...process.env,
            WINDOWS_PI_TEST_VALUE: 'literal $(not-executed)',
          },
          onData: (data) => {
            output += data.toString();
          },
        },
      );
      expect(result.exitCode).toBe(7);
      expect(output).toContain('literal $(not-executed)');
      expect(output.toLowerCase()).toContain(
        f.root.replace(/\\/g, '/').toLowerCase(),
      );
      expect(output).toContain('fixture-stderr');
    });

    test('aborts an ordinary background job through the standard SDK tool definition', async () => {
      const f = fixture();
      const controller = new AbortController();
      const tool = createBashToolDefinition(f.root, {
        operations: createWindowsBashOperations(f.shell),
        exposeSessionEnvironment: false,
      });
      const pending = Promise.resolve(
        tool.execute(
          'abort-fixture',
          { command: command(f.pidFile) },
          controller.signal,
          undefined,
          undefined as never,
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let pid: string | undefined;
      try {
        pid = await waitForPid(f.pidFile);
        await delay(150);
        controller.abort();
        const error = await bounded(pending);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Command aborted');
        expect(signalFixture(f.shell, pid, '0')).not.toBe(0);
      } finally {
        if (pid) signalFixture(f.shell, pid, 'KILL');
        controller.abort();
        await bounded(pending);
      }
    }, 15000);

    test('times out an ordinary background job through the standard SDK tool definition', async () => {
      const f = fixture();
      const tool = createBashToolDefinition(f.root, {
        operations: createWindowsBashOperations(f.shell),
        exposeSessionEnvironment: false,
      });
      const pending = Promise.resolve(
        tool.execute(
          'timeout-fixture',
          { command: command(f.pidFile), timeout: 0.5 },
          undefined,
          undefined,
          undefined as never,
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let pid: string | undefined;
      try {
        pid = await waitForPid(f.pidFile);
        const error = await bounded(pending);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'Command timed out after 0.5 seconds',
        );
        expect(signalFixture(f.shell, pid, '0')).not.toBe(0);
      } finally {
        if (pid) signalFixture(f.shell, pid, 'KILL');
        await bounded(pending);
      }
    }, 15000);

    test('does not spawn an already-aborted command', async () => {
      const f = fixture();
      const controller = new AbortController();
      controller.abort();
      await expect(
        createWindowsBashOperations(f.shell).exec(command(f.pidFile), f.root, {
          signal: controller.signal,
          onData: () => undefined,
        }),
      ).rejects.toThrow(/^aborted$/);
      expect(fs.existsSync(f.pidFile)).toBe(false);
    });

    test('returns promptly for an explicitly disowned service with all stdio redirected', async () => {
      const f = fixture();
      let output = '';
      const startedAt = Date.now();
      const pending = createWindowsBashOperations(f.shell).exec(
        `nohup sleep 30 </dev/null >/dev/null 2>&1 & pid=$!; disown "$pid"; printf '%s' "$pid"`,
        f.root,
        {
          onData: (data) => {
            output += data.toString();
          },
        },
      );
      try {
        expect((await bounded(pending)).exitCode).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(2000);
        expect(output).toMatch(/^\d+$/);
        expect(signalFixture(f.shell, output, '0')).toBe(0);
      } finally {
        // Explicit detach transfers lifecycle ownership to the caller. Clean
        // up only the logical PID printed by this fixture, never a process name.
        if (/^\d+$/.test(output)) signalFixture(f.shell, output, 'KILL');
        await bounded(pending);
      }
    }, 10000);
  },
);
