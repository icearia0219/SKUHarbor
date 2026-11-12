import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { PiRuntimeAdapter } from '../container/agent-runner/src/runtime/pi/pi-runtime.js';

afterEach(() => vi.unstubAllEnvs());

test.skipIf(process.platform !== 'win32')(
  'persists the host-selected Git Bash in Pi settings rather than selecting the WSL launcher',
  async () => {
    const git = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((entry) => entry.trim());
    expect(git).toBeTruthy();
    const bash = path.resolve(
      path.dirname(git!.trim()),
      '..',
      'bin',
      'bash.exe',
    );
    expect(fs.existsSync(bash)).toBe(true);
    vi.stubEnv('MINICLAW_HOST_BASH_PATH', bash);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendot-pi-shell-'));
    fs.mkdirSync(path.join(root, '.pi'));
    fs.writeFileSync(
      path.join(root, '.pi', 'settings.json'),
      JSON.stringify({
        shellPath: 'C:\\Windows\\System32\\bash.exe',
      }),
    );
    let session:
      | Awaited<ReturnType<PiRuntimeAdapter['createSession']>>
      | undefined;
    try {
      session = await new PiRuntimeAdapter().createSession({
        cwd: root,
        sessionDir: path.join(root, 'sessions'),
        allowedTools: ['Read'],
        model: 'windows-shell-fixture',
        thinkingLevel: 'off',
        provider: {
          api: 'openai-completions',
          endpointKind: 'custom',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'synthetic-test-key',
        },
      });
      const settings = JSON.parse(
        fs.readFileSync(path.join(root, 'agent', 'settings.json'), 'utf8'),
      );
      expect(settings.shellPath).toBe(bash);
      const native = session as unknown as {
        session: {
          settingsManager: { getShellPath(): string };
          getActiveToolNames(): string[];
        };
      };
      expect(native.session.settingsManager.getShellPath()).toBe(bash);
      expect(native.session.getActiveToolNames()).toContain('read');
      expect(native.session.getActiveToolNames()).not.toContain('bash');
    } finally {
      session?.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
