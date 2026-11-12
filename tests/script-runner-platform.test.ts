import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-platform-'));
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
afterEach(() => vi.unstubAllEnvs());

describe('host script platform execution', () => {
  test('executes shell commands using the native host installation', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const result = await runScript('printf windows-script-ok', 'workspace');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('windows-script-ok');
  });

  test('preserves host operating-system environment without leaking provider credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-secret-never-in-child');
    vi.stubEnv('OPENAI_API_KEY', 'fixture-secret-never-in-child');
    vi.stubEnv('TEMP', os.tmpdir());
    const { runScript } = await import('../src/script-runner.js');
    const node = process.execPath.replace(/\\/g, '/');
    const result = await runScript(
      `"${node}" -e 'console.log(JSON.stringify({temp:process.env.TEMP,profile:process.env.USERPROFILE,system:process.env.SystemRoot,key:process.env.ANTHROPIC_API_KEY,openai:process.env.OPENAI_API_KEY}))'`,
      'workspace',
    );
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout.trim());
    expect(env.temp).toBe(os.tmpdir());
    if (process.platform === 'win32') {
      expect(env.profile).toBeTruthy();
      expect(env.system).toBeTruthy();
    }
    expect(env.key).toBeUndefined();
    expect(env.openai).toBeUndefined();
  });

  test.skipIf(process.platform !== 'win32')(
    'reports an invalid explicitly selected Bash before executing the command',
    async () => {
      vi.stubEnv(
        'MINICLAW_HOST_BASH_PATH',
        path.join(root, 'absent', 'bash.exe'),
      );
      const { runScript, getActiveScriptCount } =
        await import('../src/script-runner.js');
      const result = await runScript('printf should-not-run', 'workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MINICLAW_HOST_BASH_PATH');
      expect(result.stderr).toContain('Git for Windows');
      expect(result.stdout).toBe('');
      expect(getActiveScriptCount()).toBe(0);
    },
  );
});
