import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, test } from 'vitest';

// Inject only filesystem probes/platform so Windows resolution can also run in Linux CI.
const windowsFiles = (...files: string[]) => ({
  platform: 'win32' as const,
  isExecutable: (candidate: string) =>
    files.some((file) => file.toLowerCase() === candidate.toLowerCase()),
});

describe('native host platform helpers', () => {
  test('resolves Windows Path and PathExt without an external which command', async () => {
    const { resolveHostBinary } = await import('../src/host-platform.js');
    expect(
      resolveHostBinary(
        'tool',
        { Path: 'D:\\first;"D:\\Tools With Spaces"', PathExt: '.EXE;.CMD' },
        windowsFiles('D:\\Tools With Spaces\\tool.cmd'),
      ),
    ).toBe('D:\\Tools With Spaces\\tool.CMD');
  });

  test('prefers an explicit Git Bash path over installations found via Git', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    const explicit = 'E:\\custom shell\\bash.exe';
    expect(
      resolveHostBashPath(
        { MINICLAW_HOST_BASH_PATH: explicit, Path: 'D:\\git\\Git\\cmd' },
        windowsFiles(
          explicit,
          'D:\\git\\Git\\cmd\\git.exe',
          'D:\\git\\Git\\bin\\bash.exe',
        ),
      ),
    ).toBe(explicit);
  });

  test('discovers Git Bash from a nonstandard git.exe installation', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    expect(
      resolveHostBashPath(
        { Path: 'D:\\git\\Git\\cmd', PATHEXT: '.EXE' },
        windowsFiles(
          'D:\\git\\Git\\cmd\\git.exe',
          'D:\\git\\Git\\bin\\bash.exe',
        ),
      ),
    ).toBe('D:\\git\\Git\\bin\\bash.exe');
  });

  test('uses the actual MSYS shell instead of the Git bin launcher when available', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    const launcher = 'D:\\git\\Git\\bin\\bash.exe';
    const actual = 'D:\\git\\Git\\usr\\bin\\bash.exe';
    expect(
      resolveHostBashPath(
        { MINICLAW_HOST_BASH_PATH: launcher },
        windowsFiles(launcher, actual),
      ),
    ).toBe(actual);
    expect(
      resolveHostBashPath(
        { Path: 'D:\\git\\Git\\cmd' },
        windowsFiles('D:\\git\\Git\\cmd\\git.exe', launcher, actual),
      ),
    ).toBe(actual);
  });

  test('checks standard Git installations when Git is absent from PATH', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    expect(
      resolveHostBashPath(
        { ProgramFiles: 'E:\\Program Files' },
        windowsFiles('E:\\Program Files\\Git\\bin\\bash.exe'),
      ),
    ).toBe('E:\\Program Files\\Git\\bin\\bash.exe');
  });

  test('skips the WSL system32 shim and keeps searching PATH', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    expect(
      resolveHostBashPath(
        { Path: 'C:\\Windows\\System32;D:\\msys64\\usr\\bin' },
        windowsFiles(
          'C:\\Windows\\System32\\bash.exe',
          'D:\\msys64\\usr\\bin\\bash.exe',
        ),
      ),
    ).toBe('D:\\msys64\\usr\\bin\\bash.exe');
    expect(
      resolveHostBashPath(
        { MINICLAW_HOST_BASH_PATH: 'C:\\Windows\\System32\\bash.exe' },
        windowsFiles('C:\\Windows\\System32\\bash.exe'),
      ),
    ).toBeNull();
  });

  test('does not silently replace a missing explicitly configured Bash', async () => {
    const { resolveHostBashPath } = await import('../src/host-platform.js');
    expect(
      resolveHostBashPath(
        {
          MINICLAW_HOST_BASH_PATH: 'Z:\\missing\\bash.exe',
          ProgramFiles: 'E:\\Program Files',
        },
        windowsFiles('E:\\Program Files\\Git\\bin\\bash.exe'),
      ),
    ).toBeNull();
  });

  test('terminates a spawned parent and its own child', async () => {
    const { killHostProcessTree } = await import('../src/host-platform.js');
    const program = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(child.pid); setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ['-e', program], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const closed = once(parent, 'close');
    let descendant: number | undefined;
    try {
      const [chunk] = await once(parent.stdout!, 'data');
      descendant = Number(String(chunk).trim());
      expect(descendant).toBeGreaterThan(0);
      expect(killHostProcessTree(parent)).toBe(true);
      await closed;
      expect(() => process.kill(descendant!, 0)).toThrow();
    } finally {
      killHostProcessTree(parent);
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* already reaped */
        }
      }
    }
  }, 10_000);
});
