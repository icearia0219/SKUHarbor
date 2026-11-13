import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { botHandoffHttpFixture } from '../helpers/bot-handoff-http-fixture.js';
import { emptyUsage, hash } from '../../src/ecommerce-ops/contracts.js';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
  getObject,
  listObjects,
  putObject,
} from '../../src/ecommerce-ops/repository.js';
import type { Artifact } from '../../src/ecommerce-ops/workflow.js';

interface FollowUp {
  id: string;
  goal_id: string;
  artifact_id: string;
  artifact_revision: number;
  content_hash: string;
  observed_goal_revision: number;
  goal_status: string;
  execution_mode: string;
  manual_only: boolean;
  review_required: boolean;
}
interface Goal {
  id: string;
  owner_user_id: string;
  workspace_jid: string;
  completion_criteria: string[];
  status: string;
  budget_max_runs: number;
  budget_used_runs: number;
  session_id: string | null;
  revision: number;
}
interface GoalView {
  goal: Goal;
  tasks: unknown[];
  executions: unknown[];
  managed_execution: boolean;
  session: unknown;
}

it('creates one bounded manual Goal over HTTP and keeps repeated refreshes and completion separate from artifact approval', async () => {
  const f = await botHandoffHttpFixture(undefined, {
    OPENDOT_ECOMMERCE_OPS: 'true',
    MINICLAW_PERSONAL_GOALS: 'true',
  });
  let db: InstanceType<typeof Database> | undefined;
  try {
    const { user } = await f.json<{ user: { id: string } }>(
      await f.call('/api/auth/me'),
    );
    const { workspaces } = await f.json<{ workspaces: { jid: string }[] }>(
      await f.call('/api/bot-groups/options'),
    );
    const workspaceId = workspaces[0]?.jid;
    expect(workspaceId).toMatch(/^web:/);

    // Only this fixture's private database is opened in the parent process.
    // No Goal is seeded: the production HTTP callback must create it.
    const databasePath = fs.realpathSync(
      path.join(f.root, 'data/db/messages.db'),
    );
    expect(databasePath.startsWith(f.root + path.sep)).toBe(true);
    db = new Database(databasePath, { fileMustExist: true, timeout: 5000 });
    createEcommerceSchema(db);
    bindEcommerceDatabase(db);
    const now = new Date().toISOString();
    const result: Artifact['result'] = {
      schema_version: '1.0',
      task_id: `ect-${randomUUID()}`,
      task_type: 'listing_pack',
      workspace_id: workspaceId,
      market: 'US',
      locale: 'en-US',
      as_of: now,
      product_refs: [],
      input_revision: 'synthetic-goal-http-input',
      policy_snapshot_id: null,
      status: 'needs_input',
      payload: null,
      claims: [],
      evidence: [],
      issues: [
        {
          code: 'MISSING_FACT',
          severity: 'blocking',
          message: 'Provide reviewed product evidence.',
          field: null,
        },
      ],
      usage: emptyUsage(),
    };
    const artifact: Artifact = {
      id: `eca-${randomUUID()}`,
      task_id: result.task_id,
      workspace_id: workspaceId,
      revision: 1,
      content_hash: hash(result),
      input_revision: result.input_revision,
      policy_snapshot_id: null,
      result,
      stale: false,
      quality: result.issues,
      dependencies: [],
      review: null,
      created_at: now,
      updated_at: now,
    };
    putObject(workspaceId, 'artifact', artifact.id, artifact, 0);
    expect(
      (await f.json<{ goals: Goal[] }>(await f.call('/api/goals'))).goals,
    ).toEqual([]);

    const body = {
      workspace_id: workspaceId,
      expected_revision: artifact.revision,
      criteria: ['Locate and manually verify the missing product evidence.'],
      due_at: new Date(Date.now() + 86400000).toISOString(),
      request_key: `goal-http-${randomUUID()}`,
    };
    const followUpUrl = `/api/ecommerce-ops/artifacts/${artifact.id}/follow-up`;
    const firstResponse = await f.call(followUpUrl, 'POST', body);
    expect(firstResponse.status).toBe(201);
    const first = await f.json<FollowUp>(firstResponse);
    const retryResponse = await f.call(followUpUrl, 'POST', body);
    expect(retryResponse.status).toBe(201);
    expect(await f.json<FollowUp>(retryResponse)).toEqual(first);
    expect(first).toMatchObject({
      artifact_id: artifact.id,
      artifact_revision: artifact.revision,
      content_hash: artifact.content_hash,
      execution_mode: 'manual',
      manual_only: true,
      review_required: true,
      goal_status: 'pending',
    });
    const goalUrl = `/api/goals/${first.goal_id}`;
    const view = await f.json<GoalView>(await f.call(goalUrl));
    expect(view.goal).toMatchObject({
      id: first.goal_id,
      owner_user_id: user.id,
      workspace_jid: workspaceId,
      completion_criteria: body.criteria,
      status: 'pending',
      budget_max_runs: 1,
      budget_used_runs: 0,
      session_id: null,
      revision: first.observed_goal_revision,
    });
    expect(view).toMatchObject({
      tasks: [],
      executions: [],
      managed_execution: false,
      session: null,
    });
    const goals = await f.json<{ goals: Goal[] }>(await f.call('/api/goals'));
    expect(goals.goals.map((goal) => goal.id)).toEqual([first.goal_id]);

    const conflict = await f.call(followUpUrl, 'POST', {
      ...body,
      criteria: ['Different criteria with the same idempotency key.'],
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const stale = await f.call(followUpUrl, 'POST', {
      ...body,
      expected_revision: 2,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'REVISION_CONFLICT' });
    const hidden = await f.call(followUpUrl, 'POST', {
      ...body,
      workspace_id: `web:unowned-${randomUUID()}`,
    });
    expect(hidden.status).toBe(404);

    const refreshUrl = `/api/ecommerce-ops/follow-ups/${first.goal_id}/refresh`;
    const refresh = () =>
      f.call(refreshUrl, 'POST', { workspace_id: workspaceId });
    const linkBefore = getObject<FollowUp>(workspaceId, 'follow_up', first.id)!;
    expect(await f.json<FollowUp>(await refresh())).toEqual(first);
    expect(await f.json<FollowUp>(await refresh())).toEqual(first);
    expect(getObject<FollowUp>(workspaceId, 'follow_up', first.id)).toEqual(
      linkBefore,
    );

    // A manual completion is a Goal lifecycle change, never an artifact approval.
    const completedResponse = await f.call(goalUrl, 'PATCH', {
      expected_revision: view.goal.revision,
      status: 'completed',
    });
    expect(completedResponse.status).toBe(200);
    const completed = (await f.json<{ goal: Goal }>(completedResponse)).goal;
    expect(completed.status).toBe('completed');
    const refreshed = await f.json<FollowUp>(await refresh());
    expect(refreshed).toMatchObject({
      goal_status: 'completed',
      observed_goal_revision: completed.revision,
      review_required: true,
      manual_only: true,
    });
    const linkAfter = getObject<FollowUp>(workspaceId, 'follow_up', first.id)!;
    expect(linkAfter.revision).toBe(linkBefore.revision + 1);
    expect(await f.json<FollowUp>(await refresh())).toEqual(refreshed);
    expect(getObject<FollowUp>(workspaceId, 'follow_up', first.id)).toEqual(
      linkAfter,
    );
    expect(listObjects(workspaceId, 'follow_up')).toHaveLength(1);
    expect(
      (await f.json<{ goals: Goal[] }>(await f.call('/api/goals'))).goals,
    ).toHaveLength(1);
    expect(
      await f.json<Artifact>(
        await f.call(
          `/api/ecommerce-ops/artifacts/${artifact.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        ),
      ),
    ).toEqual(artifact);
    const exported = await f.call(
      `/api/ecommerce-ops/artifacts/${artifact.id}/export?workspace_id=${encodeURIComponent(workspaceId)}&format=json&mode=approved`,
    );
    expect(exported.status).toBe(403);
    expect(await exported.json()).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const completedView = await f.json<GoalView>(await f.call(goalUrl));
    expect(completedView).toMatchObject({
      goal: { status: 'completed', budget_used_runs: 0 },
      tasks: [],
      executions: [],
      managed_execution: false,
      session: null,
    });
    expect(f.requests).toEqual([]);
  } finally {
    bindEcommerceDatabase(null);
    db?.close();
    await f.dispose();
  }
}, 180_000);
