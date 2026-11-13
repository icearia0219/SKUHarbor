import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-config-'));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'Miniclaw',
  DATA_DIR: tmpDir,
}));

const runtime = await import('../src/runtime-config.js');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('system brand migration', () => {
  test('defaults the product brand to SKUHarbor without renaming the assistant', () => {
    expect(runtime.getAppearanceConfig()).toMatchObject({
      appName: 'SKUHarbor',
      aiName: 'Miniclaw',
    });
  });

  test('updates the site name without erasing legacy bot appearance data', () => {
    runtime.saveAppearanceConfig({
      appName: 'Before',
      aiName: 'Legacy bot',
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: '/api/auth/avatars/system-agent-before.png',
      aiAvatarMode: 'brand',
    });

    expect(runtime.saveAppearanceConfig({ appName: 'Team Claw' })).toEqual({
      appName: 'Team Claw',
      aiName: 'Legacy bot',
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: '/api/auth/avatars/system-agent-before.png',
      aiAvatarMode: 'brand',
    });
  });

  test('can clear the global main Agent image without resetting its fallback', () => {
    expect(runtime.saveAppearanceConfig({ aiAvatarUrl: null })).toMatchObject({
      aiAvatarEmoji: '🦀',
      aiAvatarColor: '#123456',
      aiAvatarUrl: null,
      aiAvatarMode: 'brand',
    });
  });

  test.each(['OpenDot', 'Miniclaw', 'MiniClaw'])(
    'presents legacy product name %s as SKUHarbor while retaining custom agent data',
    (appName) => {
      const config = path.join(tmpDir, 'config', 'appearance.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(
        config,
        JSON.stringify({
          appName,
          aiName: 'My own assistant',
          aiAvatarColor: '#123456',
        }),
      );
      expect(runtime.getAppearanceConfig()).toMatchObject({
        appName: 'SKUHarbor',
        aiName: 'My own assistant',
        aiAvatarColor: '#123456',
      });
    },
  );

  test('preserves a custom site name when saving appearance', () => {
    expect(
      runtime.saveAppearanceConfig({ appName: 'My Seller Team' }),
    ).toMatchObject({
      appName: 'My Seller Team',
      aiName: 'My own assistant',
    });
  });
});
