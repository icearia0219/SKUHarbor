import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BashOperations } from '@earendil-works/pi-coding-agent';

// Docker builds copy only agent-runner/, so even type imports must not depend
// on the host-only shared module outside that build context.
interface WindowsProcessHelpers {
  prepareWindowsBashCommand(command: string): string;
  killWindowsProcessTree(childPid: number, bashPath: string): boolean;
}

/** Supply to createBashToolDefinition so Pi retains schemas and output limits. */
export function createWindowsBashOperations(shellPath: string): BashOperations {
  if (process.platform !== 'win32') {
    throw new Error('Windows Bash operations require Windows');
  }
  // src/runtime/pi and dist/runtime/pi have the same depth. Keep this require
  // inside the Windows factory so Linux containers never load the host helper.
  const helperPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../shared/windows-process.cjs',
  );
  const helpers = createRequire(import.meta.url)(
    helperPath,
  ) as WindowsProcessHelpers;

  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (signal?.aborted) throw new Error('aborted');
      if (
        timeout !== undefined &&
        (!Number.isFinite(timeout) ||
          timeout <= 0 ||
          timeout * 1000 > 2_147_483_647)
      ) {
        throw new Error(
          'Invalid timeout: expected positive finite seconds within the Node.js timer range',
        );
      }
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(
          `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
        );
      }
      if (signal?.aborted) throw new Error('aborted');
      return new Promise((resolve, reject) => {
        const child = spawn(
          shellPath,
          ['-c', helpers.prepareWindowsBashCommand(command)],
          {
            cwd,
            env: env ?? process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let settled = false;
        let exited = false;
        let stopped: 'aborted' | 'timeout' | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let idleHandle: ReturnType<typeof setTimeout> | undefined;
        let stopHandle: ReturnType<typeof setTimeout> | undefined;
        const finish = (exitCode: number | null, error?: Error) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (idleHandle) clearTimeout(idleHandle);
          if (stopHandle) clearTimeout(stopHandle);
          signal?.removeEventListener('abort', abort);
          child.stdout.removeListener('data', output);
          child.stderr.removeListener('data', output);
          child.stdout.destroy();
          child.stderr.destroy();
          if (error) reject(error);
          else if (stopped)
            reject(
              new Error(
                stopped === 'aborted' ? 'aborted' : `timeout:${timeout}`,
              ),
            );
          else resolve({ exitCode });
        };
        const armIdle = (exitCode: number | null) => {
          if (idleHandle) clearTimeout(idleHandle);
          // Match Pi's post-exit output drain: an intentionally detached quiet
          // descendant must not hold this tool's output pipes open forever.
          idleHandle = setTimeout(() => finish(exitCode), 100);
        };
        const output = (data: Buffer) => {
          if (settled) return;
          onData(data);
          if (exited) armIdle(child.exitCode);
        };
        const stop = (reason: 'aborted' | 'timeout') => {
          if (settled || stopped) return;
          stopped = reason;
          if (exited) return finish(child.exitCode);
          try {
            if (
              !child.pid ||
              !helpers.killWindowsProcessTree(child.pid, shellPath)
            ) {
              return finish(
                null,
                new Error(
                  'Windows Bash process termination could not be verified',
                ),
              );
            }
          } catch {
            return finish(
              null,
              new Error('Windows Bash process termination failed'),
            );
          }
          stopHandle = setTimeout(
            () =>
              finish(
                null,
                new Error(
                  'Windows Bash process did not exit after cancellation',
                ),
              ),
            1000,
          );
        };
        const abort = () => stop('aborted');
        child.stdout.on('data', output);
        child.stderr.on('data', output);
        child.once('error', (error) => finish(null, error));
        child.once('exit', (code) => {
          exited = true;
          armIdle(code);
        });
        child.once('close', (code) => finish(code));
        if (timeout !== undefined)
          timeoutHandle = setTimeout(() => stop('timeout'), timeout * 1000);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}
