import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { checkPluginDependencies } from '../src/plugin-dependency-check.js';
import { resolveHostBashPath } from '../src/host-platform.js';

const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-platform-'));
fs.mkdirSync(path.join(plugin, 'commands'));
fs.writeFileSync(
  path.join(plugin, 'commands', 'run.md'),
  '---\nallowed-tools: Bash(bash:*)\n---\nRun the command.\n',
);
afterAll(() => fs.rmSync(plugin, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe('host plugin dependency preflight', () => {
  test('recognizes the same explicitly selected Bash as plugin execution', () => {
    const bash = resolveHostBashPath();
    expect(bash).toBeTruthy();
    vi.stubEnv('MINICLAW_HOST_BASH_PATH', bash!);
    vi.stubEnv('PATH', path.dirname(process.execPath));
    expect(
      checkPluginDependencies(plugin, 'fixture@native', { runtime: 'host' })
        .missing,
    ).toEqual([]);
  });
});
