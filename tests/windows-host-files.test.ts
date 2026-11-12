import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  reconcileSessionSkills,
  resolveEffectiveSkills,
} from '../src/effective-skill-resolver.js';
import {
  buildClaudeContextPlan,
  syncHostClaudeContext,
} from '../src/claude-context-resolver.js';
import { validateAndResolvePath } from '../src/file-manager.js';

const roots: string[] = [];
function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-host-files-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of roots.splice(0))
    fs.rmSync(value, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'win32')(
  'selected Skills work without file symlink privileges and disabling removes them',
  () => {
    const directory = root();
    const source = path.join(directory, 'managed', 'selected');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# selected');
    const original = fs.symlinkSync;
    vi.spyOn(fs, 'symlinkSync').mockImplementation(
      (target, destination, type) => {
        if (type !== 'junction')
          throw Object.assign(new Error('No symlink privilege'), {
            code: 'EPERM',
          });
        return original(target, destination, type);
      },
    );
    const session = path.join(directory, 'session');
    const manifest = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: path.dirname(source) }],
    });
    reconcileSessionSkills(session, manifest, { materializeLinks: true });
    expect(
      fs.readFileSync(
        path.join(session, 'skills', 'selected', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('# selected');
    expect(
      fs.lstatSync(path.join(session, 'skills', 'selected')).isSymbolicLink(),
    ).toBe(true);
    reconcileSessionSkills(session, resolveEffectiveSkills({ layers: [] }), {
      materializeLinks: true,
    });
    expect(fs.readdirSync(path.join(session, 'skills'))).toEqual([]);
    expect(fs.existsSync(source)).toBe(true);
  },
);

test.skipIf(process.platform !== 'win32')(
  'copied host instructions refresh and are removed on policy changes while authored files survive',
  () => {
    const directory = root();
    const external = path.join(directory, 'external');
    const session = path.join(directory, 'session');
    fs.mkdirSync(external);
    const source = path.join(external, 'CLAUDE.md');
    fs.writeFileSync(source, '# first host instruction');
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('No privilege'), { code: 'EPERM' });
    });
    const base = {
      executionMode: 'host' as const,
      group: { folder: 'main', created_by: 'owner' } as any,
      externalClaudeDir: external,
      projectRoot: directory,
      dataDir: path.join(directory, 'data'),
      groupSessionsDir: session,
    };
    const sync = (enabled: boolean) =>
      syncHostClaudeContext(
        buildClaudeContextPlan({ ...base, includeHostClaudeContext: enabled }),
        session,
      );
    expect(sync(true).claudeMdStatus).toBe('linked');
    const projected = path.join(session, 'CLAUDE.md');
    expect(fs.readFileSync(projected, 'utf8')).toBe('# first host instruction');
    fs.writeFileSync(source, '# updated host instruction');
    sync(true);
    expect(fs.readFileSync(projected, 'utf8')).toBe(
      '# updated host instruction',
    );
    sync(false);
    expect(fs.existsSync(projected)).toBe(false);
    sync(true);
    fs.writeFileSync(projected, '# session-authored');
    expect(sync(true).claudeMdStatus).toBe('shadowed');
    sync(false);
    expect(fs.readFileSync(projected, 'utf8')).toBe('# session-authored');
  },
);

test
  .skipIf(process.platform !== 'win32')
  .each([
    'D:\\opendot-nonexistent-outside-file',
    '\\\\invalid-server\\share\\outside',
    'file.txt:stream',
    'NUL.txt',
    'nested/COM1.log',
    'name.',
    'name ',
  ])(
  'workspace file paths reject Windows aliases and external roots: %s',
  (value) => {
    const directory = root();
    expect(() => validateAndResolvePath('unused', value, directory)).toThrow();
  },
);
