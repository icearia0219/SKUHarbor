import { beforeEach, afterEach, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createEcommerceRoutes } from '../../src/ecommerce-ops/routes.js';
import {
  createEcommerceSchema,
  bindEcommerceDatabase,
  getObject,
} from '../../src/ecommerce-ops/repository.js';
import { getProduct } from '../../src/ecommerce-ops/facts.js';
import { emptyUsage } from '../../src/ecommerce-ops/contracts.js';
let db: InstanceType<typeof Database>, enabled: boolean;
const model = async ({ snapshot }: any) => {
  const text = '1500 W';
  const ev = snapshot.evidence.find((e: any) => e.kind === 'product_fact');
  return {
    text: JSON.stringify({
      ...snapshot.bound,
      schema_version: '1.0',
      status: 'draft',
      payload: {
        title: text,
        bullets: [text],
        description: text,
        search_terms: [],
        rule_coverage: 'partial',
        unchecked_rules: ['Not full platform validation'],
      },
      claims: ['title', 'bullets/0', 'description'].map((field) => ({
        claim_id: field,
        text,
        field_path: '/payload/' + field,
        evidence_refs: [ev.evidence_id],
      })),
      evidence: snapshot.evidence,
      issues: [],
      usage: emptyUsage(),
    }),
    usage: emptyUsage(),
  };
};
const app = (adapter: any = model) =>
  createEcommerceRoutes({
    enabled: () => enabled,
    auth: async (c, next) => {
      if (c.req.header('X-Test-User') !== 'owner')
        return c.json({ error: 'unauthorized' }, 401);
      c.set('user', { id: 'owner', role: 'admin' } as any);
      await next();
    },
    authorize: (ws, user) => {
      if (ws !== 'w' || user !== 'owner') throw new Error('NOT_FOUND');
    },
    model: adapter,
  });
const call = (a: any, path: string, method = 'GET', body?: any) =>
  a.request('http://localhost' + path, {
    method,
    headers: {
      'X-Test-User': 'owner',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(() => {
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
  enabled = true;
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
});
async function seed(a: any) {
  expect(
    (
      await call(a, '/products', 'POST', {
        workspace_id: 'w',
        product: {
          id: 'p',
          sku: 'US-1',
          market: 'US',
          locale: 'en-US',
          product_type: 'heater',
          seller_scope: 'self',
        },
      })
    ).status,
  ).toBe(201);
  const metadata = {
    kind: 'product_fact',
    provenance: 'synthetic',
    owner_scope: 'w',
    market: 'US',
    locale: 'en-US',
    product_refs: [
      { product_id: 'p', sku: 'US-1', revision: '1', market: 'US' },
    ],
    observed_at: new Date().toISOString(),
    rights_note: 'synthetic test',
  };
  const imported = await (
    await call(a, '/assets', 'POST', {
      workspace_id: 'w',
      name: 'facts.csv',
      text: 'sku,field,value,unit,value_type\nUS-1,power,1500,W,number',
      metadata,
      request_key: 'facts',
    })
  ).json();
  expect(imported.candidates.length).toBe(1);
  expect(
    (
      await call(a, '/products/p/confirm', 'POST', {
        workspace_id: 'w',
        expected_revision: getProduct('w', 'p')!.revision,
        reason: 'Checked against fixture',
        decisions: imported.candidates.map((f: any) => ({
          evidence_id: f.evidence_id,
          verification_state: 'confirmed',
        })),
      })
    ).status,
  ).toBe(200);
  const policy = await (
    await call(a, '/assets', 'POST', {
      workspace_id: 'w',
      name: 'rules.json',
      text: JSON.stringify({
        listing_pack: { version: 'demo', required_fields: ['/payload/title'] },
      }),
      metadata: {
        ...metadata,
        kind: 'policy',
        product_refs: [],
        effective_from: '2020-01-01T00:00:00Z',
      },
      request_key: 'policy',
    })
  ).json();
  expect(
    (
      await call(a, '/knowledge', 'POST', {
        workspace_id: 'w',
        asset_id: policy.asset.source_id,
        metadata: {
          id: 'policy',
          product_type: 'heater',
          seller_scope: 'self',
          authority: 'official',
          approval_state: 'approved',
          version: 'demo',
        },
      })
    ).status,
  ).toBe(201);
  return imported;
}
it('B09 feature gate and auth reject direct API writes', async () => {
  const a = app();
  expect((await a.request('/workspace?workspace_id=w')).status).toBe(401);
  enabled = false;
  expect((await call(a, '/availability')).status).toBe(200);
  expect((await call(a, '/products', 'POST', {})).status).toBe(404);
});
it('B09 wrong workspace evidence/task IDs fail without exposing contents', async () => {
  const a = app();
  const imported = await seed(a);
  expect(
    (
      await call(
        a,
        '/assets/' + imported.asset.source_id + '/content?workspace_id=other',
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        a,
        '/evidence/' +
          imported.candidates[0].evidence_id +
          '?workspace_id=other',
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(a, '/products', 'POST', {
        workspace_id: 'other',
        product: {
          sku: 'X',
          market: 'US',
          locale: 'en-US',
          product_type: 'heater',
          seller_scope: 'self',
        },
      })
    ).status,
  ).toBe(404);
});
it('runs import/confirm/rules/task/review/export through real Hono and SQLite', async () => {
  const a = app();
  await seed(a);
  const response = await call(a, '/tasks', 'POST', {
    workspace_id: 'w',
    task_type: 'listing_pack',
    market: 'US',
    locale: 'en-US',
    product_ids: ['p'],
    request_key: 'listing',
  });
  expect(response.status).toBe(202);
  const task = await response.json();
  let done: any;
  for (let i = 0; i < 30; i++) {
    done = await (
      await call(a, '/tasks/' + task.id + '?workspace_id=w')
    ).json();
    if (done.artifact) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(done.error).toBeNull();
  expect(done.status).toBe('waiting_review');
  const artifact = done.artifact;
  expect(
    (
      await call(
        a,
        '/artifacts/' +
          artifact.id +
          '/export?workspace_id=w&format=json&mode=approved',
      )
    ).status,
  ).toBe(403);
  const approved = await call(
    a,
    '/artifacts/' + artifact.id + '/review',
    'POST',
    {
      workspace_id: 'w',
      expected_revision: artifact.revision,
      content_hash: artifact.content_hash,
      decision: 'approve',
      reason: 'Manually checked synthetic facts',
      request_key: 'approve',
    },
  );
  expect(approved.status).toBe(200);
  const exported = await call(
    a,
    '/artifacts/' +
      artifact.id +
      '/export?workspace_id=w&format=json&mode=approved',
  );
  expect(exported.status).toBe(200);
  expect((await exported.json()).result.payload.title).toBe('1500 W');
});
it('uses an explicitly selected reviewed order without leaking raw order PII, and never auto-selects it', async () => {
  let captured: any;
  const a = app(async ({ snapshot }: any) => {
    captured = snapshot;
    return {
      text: JSON.stringify({
        ...snapshot.bound,
        schema_version: '1.0',
        status: 'draft',
        payload: {
          ticket_id: snapshot.data.support.ticket_id,
          intent: 'refund',
          action: snapshot.data.support_gate.action,
          reply_body: 'Please contact our support team for further assistance.',
          order_evidence_refs: snapshot.data.support.order?.evidence_refs ?? [],
          internal_notes_zh: ['基于已审核导入资料的内部草稿'],
        },
        claims: [],
        evidence: snapshot.evidence,
        issues: [],
        usage: emptyUsage(),
      }),
      usage: emptyUsage(),
    };
  });
  await seed(a);
  const p = getProduct('w', 'p')!,
    now = new Date().toISOString();
  const refs = [
    {
      product_id: p.id,
      sku: p.sku,
      revision: String(p.revision),
      market: 'US',
    },
  ];
  async function source(kind: string, name: string, text: string, key: string) {
    const response = await call(a, '/assets', 'POST', {
      workspace_id: 'w',
      name,
      text,
      metadata: {
        kind,
        provenance: 'synthetic',
        owner_scope: 'w',
        market: 'US',
        locale: 'en-US',
        product_refs: kind === 'order' ? refs : [],
        observed_at: now,
        effective_from: '2020-01-01T00:00:00Z',
        rights_note: 'synthetic manual-import fixture',
      },
      request_key: key,
    });
    expect(response.status).toBe(201);
    const value = await response.json();
    const k = await call(a, '/knowledge', 'POST', {
      workspace_id: 'w',
      asset_id: value.asset.source_id,
      metadata: {
        id: key,
        product_type: 'heater',
        seller_scope: 'self',
        authority: 'merchant',
        approval_state: 'approved',
      },
    });
    expect(k.status).toBe(201);
    return value.asset.source_id;
  }
  await source(
    'policy',
    'support.txt',
    'Merchant refund support policy: use approved order evidence and do not invent execution.',
    'support-policy',
  );
  const order = await source(
    'order',
    'order.json',
    JSON.stringify({
      workspace_id: 'w',
      market: 'US',
      ticket_id: 'private@example.invalid',
      observed_at: now,
      valid_until: new Date(Date.now() + 86400000).toISOString(),
      ownership_verified: true,
      customer_email: 'private@example.invalid',
      customer_address: '23 Private Road',
      refund: {
        state: 'completed',
        receipt: { id: 'private-receipt-id', completed_at: now },
      },
    }),
    'order',
  );
  const run = async (key: string, asset_ids?: string[]) => {
    const res = await call(a, '/tasks', 'POST', {
      workspace_id: 'w',
      task_type: 'support_draft',
      market: 'US',
      locale: 'en-US',
      product_ids: ['p'],
      asset_ids,
      support: {
        ticket: {
          ticket_id: 'private@example.invalid',
          text: 'I request a refund.',
        },
      },
      request_key: key,
    });
    expect(res.status).toBe(202);
    const t = await res.json();
    for (let i = 0; i < 30; i++) {
      const state = await (
        await call(a, '/tasks/' + t.id + '?workspace_id=w')
      ).json();
      if (state.artifact) return state;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('Task did not finish');
  };
  const selected = await run('selected-order', [order]);
  expect(selected.status).toBe('waiting_review');
  expect(captured.data.support.order.refund_completed_verified).toBe(true);
  expect(JSON.stringify(captured.data)).not.toContain(
    'private@example.invalid',
  );
  expect(JSON.stringify(captured.evidence)).not.toContain('23 Private Road');
  expect(JSON.stringify(captured.evidence)).not.toContain('private-receipt-id');
  await run('no-order-selection');
  expect(captured.data.support.order).toBeNull();
  expect(captured.data.support_gate.action).toBe('needs_info');
});
