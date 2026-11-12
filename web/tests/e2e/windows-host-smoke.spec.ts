import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { botHandoffHttpFixture } from '../../../tests/helpers/bot-handoff-http-fixture';

test('native Windows browser uses the real Host Pi Runner and Git Bash, then reloads persisted messages', async ({
  page,
}) => {
  test.skip(process.platform !== 'win32', 'native Windows acceptance');
  const fixture = await botHandoffHttpFixture(undefined, {
    MINICLAW_DURABLE_RUNTIME: 'false',
    MINICLAW_BOT_HANDOFFS: 'false',
  });
  try {
    const account = await fixture.json<{ user: { id: string } }>(
      await fixture.call('/api/auth/me'),
    );
    const skillId = 'windows-acceptance';
    const skill = path.join(
      fixture.root,
      'data',
      'skills',
      account.user.id,
      skillId,
    );
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(
      path.join(skill, 'SKILL.md'),
      '---\nname: windows-acceptance\ndescription: Windows capability projection verification.\n---\nUse the configured shell for the verification.\n',
    );
    const dot = await fixture.json<{
      profile: { id: string };
      jid: string;
      folder: string;
    }>(
      await fixture.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Windows acceptance Dot',
        avatar_shape: 'clover',
        avatar_color: '#10b981',
        identity_prompt: '',
      }),
    );
    await fixture.json(
      await fixture.call(`/api/agent-profiles/${dot.profile.id}`, 'PATCH', {
        runtime_policy: { skills: { mode: 'custom', ids: [skillId] } },
      }),
    );
    const workspace = path.join(fixture.root, 'data', 'groups', dot.folder);
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.pi', 'settings.json'),
      JSON.stringify({ shellPath: 'C:\\Windows\\System32\\bash.exe' }),
    );
    fixture.setModel((body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'WINDOWS_HOST_BASH_OK' }
        : {
            tool: {
              name: 'bash',
              arguments: {
                command:
                  "printf 'WINDOWS_HOST_BASH_OK' > windows-host-proof.txt; cat windows-host-proof.txt",
              },
            },
          },
    );
    await page.request.post(fixture.origin + '/api/auth/login', {
      data: fixture.credentials,
    });
    await page.goto(`${fixture.origin}/bots?profile=${dot.profile.id}`);
    await expect(page.getByRole('textbox')).toBeVisible();
    await page
      .getByRole('textbox')
      .fill('Run the shell verification and report its result.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const timeline = page.locator('[data-conversation-timeline] [data-index]');
    await expect(timeline.last()).toContainText('WINDOWS_HOST_BASH_OK', {
      timeout: 90_000,
    });
    const proof = path.join(
      fixture.root,
      'data',
      'groups',
      dot.folder,
      'windows-host-proof.txt',
    );
    expect(fs.readFileSync(proof, 'utf8')).toBe('WINDOWS_HOST_BASH_OK');
    expect(fixture.requests.length).toBe(2);
    expect(
      fixture.requests[1].messages.some((message) => message.role === 'tool'),
    ).toBe(true);
    await page.reload();
    await expect(timeline.last()).toContainText('WINDOWS_HOST_BASH_OK');
    await expect(
      page.getByRole('button', { name: '发送消息', exact: true }),
    ).toBeVisible();
    await fixture.stop();
    await fixture.start();
    await page.reload();
    await expect(timeline.last()).toContainText('WINDOWS_HOST_BASH_OK');
    fixture.setModel(() => ({ text: 'WINDOWS_SECOND_TURN_OK' }));
    await page.getByRole('textbox').fill('Continue this same conversation.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(timeline.last()).toContainText('WINDOWS_SECOND_TURN_OK', {
      timeout: 60_000,
    });
    expect(fixture.requests.length).toBe(3);
    expect(
      fixture.requests[2].messages.some((message) =>
        JSON.stringify(message.content).includes('WINDOWS_HOST_BASH_OK'),
      ),
    ).toBe(true);
  } finally {
    await fixture.dispose();
  }
});
