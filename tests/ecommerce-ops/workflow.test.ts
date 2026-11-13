import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
  getObject,
  putObject,
} from '../../src/ecommerce-ops/repository.js';
import { EcommerceWorkflow } from '../../src/ecommerce-ops/workflow.js';
import { emptyUsage } from '../../src/ecommerce-ops/contracts.js';
const request: any = {
  task_type: 'listing_pack',
  market: 'US',
  locale: 'en-US',
  product_ids: ['p'],
};
let db: InstanceType<typeof Database>;
beforeEach(() => {
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
});
const fixture = () =>
  new EcommerceWorkflow({
    freeze: (t: any) => ({
      bound: {
        task_id: t.id,
        task_type: 'listing_pack',
        workspace_id: 'w',
        market: 'US',
        locale: 'en-US',
        as_of: '2026-11-12T00:00:00Z',
        product_refs: [],
        input_revision: 'same',
        policy_snapshot_id: null,
      },
      products: [],
      evidence: [],
      rules: [],
      dependencies: [],
      issues: [],
      data: {},
    }),
    model: async ({ snapshot }: any) => ({
      text: JSON.stringify({
        ...snapshot.bound,
        schema_version: '1.0',
        status: 'needs_input',
        payload: null,
        claims: [],
        evidence: [],
        issues: [
          {
            code: 'MISSING',
            severity: 'blocking',
            message: 'Need product',
            field: null,
          },
        ],
        usage: emptyUsage(),
      }),
      usage: emptyUsage(),
    }),
  });
it('B20 keeps one durable task for a repeated request and rejects changed input', () => {
  const w: any = fixture();
  const a = w.startTask('w', 'owner', request, 'key');
  expect(w.startTask('w', 'owner', request, 'key').id).toBe(a.id);
  expect(() =>
    w.startTask('w', 'owner', { ...request, query: 'different' }, 'key'),
  ).toThrow();
});
it('B19 resumes the same task and commits its artifact/checkpoint atomically', async () => {
  const w: any = fixture();
  const t = w.startTask('w', 'owner', request, 'resume');
  await w.resumeTask('w', t.id);
  const x = w.getTask('w', t.id);
  expect(x.status).toBe('needs_input');
  expect(x.artifact).toBeTruthy();
  const again: any = fixture();
  await again.resumeTask('w', t.id);
  expect(again.getTask('w', t.id).artifact.id).toBe(x.artifact.id);
});
it('B21 caps format repairs instead of looping until success', async () => {
  const w: any = fixture();
  w.deps.model = async () => ({ text: 'invalid', usage: emptyUsage() });
  const t = w.startTask('w', 'owner', request, 'bad');
  await w.resumeTask('w', t.id);
  const x = w.getTask('w', t.id);
  expect(x.status).toBe('failed');
  expect(x.generations).toBe(2);
});
it('B20 concurrent execution produces one artifact', async () => {
  const w: any = fixture();
  const t = w.startTask('w', 'owner', request, 'parallel');
  await Promise.all([w.resumeTask('w', t.id), w.resumeTask('w', t.id)]);
  expect(w.getTask('w', t.id).artifact.id).toBeTruthy();
  expect(
    getObject('w', 'artifact', w.getTask('w', t.id).artifact.id)?.revision,
  ).toBe(1);
});
it('B21 bounds a stalled model and records the execution budget failure', async () => {
  const w: any = fixture();
  w.deps.maxElapsedMs = () => 10;
  w.deps.model = () => new Promise(() => {});
  const t = w.startTask('w', 'owner', request, 'timeout');
  await Promise.race([
    w.resumeTask('w', t.id),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('unbounded generation')), 250),
    ),
  ]);
  expect(w.getTask('w', t.id).error).toBe('BUDGET_EXHAUSTED');
});
it('B21 records quota exhaustion without format repair or hidden retries', async () => {
  const w: any = fixture();
  let calls = 0;
  w.deps.model = async () => {
    calls++;
    throw new Error('BUDGET_EXHAUSTED');
  };
  const t = w.startTask('w', 'owner', request, 'quota');
  await w.resumeTask('w', t.id);
  expect(calls).toBe(1);
  expect(w.getTask('w', t.id).artifact.result.issues[0].code).toBe(
    'BUDGET_EXHAUSTED',
  );
});
it('B21 cancellation fences a late model response from artifact creation', async () => {
  const w: any = fixture();
  let finish: any;
  w.deps.model = () =>
    new Promise((r) => {
      finish = r;
    });
  const t = w.startTask('w', 'owner', request, 'cancel');
  const running = w.resumeTask('w', t.id);
  await new Promise((r) => setTimeout(r, 1));
  w.pauseTask('w', t.id, true);
  finish({ text: '{}', usage: emptyUsage() });
  await running;
  expect(w.getTask('w', t.id).status).toBe('cancelled');
  expect(w.getTask('w', t.id).artifact).toBeNull();
});
it.each([false, true])(
  'rejects a wrong-workspace pause/cancel (%s) without aborting the running owner task',
  async (cancel) => {
    const w = fixture();
    const originalModel = w.deps.model;
    let finish!: () => void;
    let signal!: AbortSignal;
    w.deps.model = async (input) => {
      signal = input.signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return originalModel(input);
    };
    const task = w.startTask('w', 'owner', request, 'scope-' + cancel);
    const running = w.resumeTask('w', task.id);
    try {
      const before = w.getTask('w', task.id);
      expect(before.status).toBe('generating');
      expect(() => w.pauseTask('other-workspace', task.id, cancel)).toThrow(
        'NOT_FOUND',
      );
      expect(signal.aborted).toBe(false);
      expect(w.getTask('w', task.id)).toEqual(before);
    } finally {
      finish();
      await running;
    }
    expect(w.getTask('w', task.id).status).toBe('needs_input');
  },
);
it('does not abort a model when the pause transaction fails to commit', async () => {
  const w = fixture();
  const originalModel = w.deps.model;
  let finish!: () => void;
  let signal!: AbortSignal;
  w.deps.model = async (input) => {
    signal = input.signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return originalModel(input);
  };
  const task = w.startTask('w', 'owner', request, 'pause-rollback');
  const running = w.resumeTask('w', task.id);
  db.exec(`CREATE TEMP TRIGGER reject_pause BEFORE UPDATE ON ecommerce_objects
    WHEN NEW.kind='task' AND json_extract(NEW.body,'$.status')='paused'
    BEGIN SELECT RAISE(ABORT,'pause_write_rejected'); END;`);
  try {
    const before = w.getTask('w', task.id);
    expect(() => w.pauseTask('w', task.id)).toThrow('pause_write_rejected');
    expect(signal.aborted).toBe(false);
    expect(w.getTask('w', task.id)).toEqual(before);
  } finally {
    db.exec('DROP TRIGGER reject_pause');
    finish();
    await running;
  }
  expect(w.getTask('w', task.id).status).toBe('needs_input');
});
