import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
  getObject,
  putObject,
  putSourceAsset,
  sha256,
} from '../../src/ecommerce-ops/repository.js';
import { createEcommerceRoutes } from '../../src/ecommerce-ops/routes.js';
import {
  EcommerceWorkflow,
  type Artifact,
  type FrozenInputs,
  type WorkflowTask,
} from '../../src/ecommerce-ops/workflow.js';
import { freezeTask } from '../../src/ecommerce-ops/service.js';
import { ingestKnowledge } from '../../src/ecommerce-ops/knowledge.js';
import {
  emptyUsage,
  hash,
  type TaskResult,
} from '../../src/ecommerce-ops/contracts.js';
import { validateQuality } from '../../src/ecommerce-ops/quality.js';
import type {
  Evidence,
  Product,
  TaskType,
} from '../../src/ecommerce-ops/domain.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
});
const evidence: Evidence = {
  evidence_id: 'own-power',
  source_id: 'own',
  kind: 'product_fact',
  locator: 'chars:0-6',
  content_hash: hash('1500 W'),
  provenance: 'synthetic',
  excerpt: '1500 W',
};
const product: Product = {
  id: 'p',
  workspace_id: 'w',
  sku: 'US',
  market: 'US',
  locale: 'en-US',
  product_type: 'KETTLE',
  seller_scope: 'self',
  revision: 1,
  facts: [
    {
      field: 'power',
      value: 1500,
      unit: 'W',
      evidence_id: 'own-power',
      verification_state: 'confirmed',
    },
  ],
};
function result(taskType: TaskType = 'listing_pack'): TaskResult {
  return {
    schema_version: '1.0',
    task_id: 't',
    task_type: taskType,
    workspace_id: 'w',
    market: 'US',
    locale: 'en-US',
    as_of: '2026-06-01T00:00:00Z',
    product_refs: [{ product_id: 'p', sku: 'US', market: 'US', revision: '1' }],
    input_revision: 'input-1',
    policy_snapshot_id: 'policy',
    status: 'draft',
    payload: {
      title: '1500 W',
      bullets: ['1500 W'],
      description: '1500 W',
      search_terms: [],
      rule_coverage: 'partial',
      unchecked_rules: ['Synthetic review fixture'],
    },
    claims: ['title', 'bullets/0', 'description'].map((field) => ({
      claim_id: field,
      text: '1500 W',
      field_path: '/payload/' + field,
      evidence_refs: ['own-power'],
    })),
    evidence: [evidence],
    issues: [],
    usage: emptyUsage(),
  };
}
const app = () =>
  createEcommerceRoutes({
    enabled: () => true,
    auth: async (c, next) => {
      c.set('user', { id: 'owner', role: 'member' } as any);
      await next();
    },
    authorize: (ws, user) => {
      if (ws !== 'w' || user !== 'owner') throw new Error('NOT_FOUND');
    },
  });
const call = (
  a: ReturnType<typeof app>,
  url: string,
  method = 'GET',
  body?: unknown,
) =>
  a.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
function artifactSeed(value: TaskResult): Artifact {
  const snapshot: FrozenInputs = {
    bound: value,
    products: [product],
    evidence: [evidence],
    rules: [],
    dependencies: [],
    issues: [],
    data: { metrics: value.payload?.metrics, maturity: 'complete' },
  };
  const artifact: Artifact = {
    id: 'a',
    task_id: 't',
    workspace_id: 'w',
    revision: 1,
    content_hash: hash(value),
    input_revision: value.input_revision,
    policy_snapshot_id: value.policy_snapshot_id,
    result: value,
    stale: false,
    quality: [],
    dependencies: [],
    review: null,
    created_at: value.as_of,
    updated_at: value.as_of,
  };
  putObject('w', 'artifact', 'a', artifact, 0);
  putObject(
    'w',
    'task',
    't',
    {
      id: 't',
      workspace_id: 'w',
      owner_id: 'owner',
      revision: 1,
      artifact_id: 'a',
      snapshot,
      request: {
        task_type: value.task_type,
        product_ids: ['p'],
        market: 'US',
        locale: 'en-US',
      },
    },
    0,
  );
  return artifact;
}

it('SECURITY P1 binds each claimed fact to the actual output text, not merely its field pointer', () => {
  const draft = result();
  draft.payload!.title = 'Bluetooth-enabled 1500 W heater';
  expect(
    validateQuality(draft, { products: [product], evidence: [evidence] }).some(
      (i) => i.severity === 'blocking',
    ),
  ).toBe(true);
});

it('SECURITY P1 prevents edited code-owned advertising metrics from receiving approved export', async () => {
  const value = result('ads_diagnosis');
  value.claims = [];
  value.payload = {
    report_id: 'r',
    metrics_ref: 'm',
    metrics: {
      currency: 'USD',
      spend_minor: 100,
      attributed_sales_minor: 200,
      impressions: 1000,
      clicks: 10,
      attributed_orders: 1,
      acos_ratio: 0.5,
      roas: 2,
      ctr_ratio: 0.01,
      cpc_minor: 10,
      cvr_ratio: 0.1,
    },
    maturity: 'complete',
    findings: [],
    missing_context: [],
  };
  artifactSeed(value);
  const a = app();
  const patch = await call(a, '/artifacts/a', 'PATCH', {
    workspace_id: 'w',
    expected_revision: 1,
    payload: {
      ...value.payload,
      metrics: { ...(value.payload.metrics as object), spend_minor: 1 },
    },
  });
  if (patch.status !== 200) {
    expect(patch.status).toBeGreaterThanOrEqual(400);
    return;
  }
  const edited = (await patch.json()) as Artifact;
  const reviewed = await call(a, '/artifacts/a/review', 'POST', {
    workspace_id: 'w',
    expected_revision: 2,
    content_hash: edited.content_hash,
    decision: 'approve',
    reason: 'Human review cannot replace deterministic calculation',
    request_key: 'tampered-metrics',
  });
  expect(reviewed.status).toBe(403);
});

it('SECURITY P1 reruns support completion guards after a human edits the payload', async () => {
  const value = result('support_draft');
  value.claims = [];
  value.payload = {
    ticket_id: 'ticket',
    intent: 'refund',
    action: 'needs_info',
    reply_body: 'Please provide the order reference.',
    order_evidence_refs: [],
    internal_notes_zh: [],
  };
  artifactSeed(value);
  const a = app();
  const patch = await call(a, '/artifacts/a', 'PATCH', {
    workspace_id: 'w',
    expected_revision: 1,
    payload: {
      ...value.payload,
      action: 'reply_draft',
      reply_body: 'Your refund has been processed.',
    },
  });
  if (patch.status !== 200) {
    expect(patch.status).toBeGreaterThanOrEqual(400);
    return;
  }
  const edited = (await patch.json()) as Artifact;
  expect(
    (
      await call(a, '/artifacts/a/review', 'POST', {
        workspace_id: 'w',
        expected_revision: 2,
        content_hash: edited.content_hash,
        decision: 'approve',
        reason: 'No receipt supports completion',
        request_key: 'edited-refund',
      })
    ).status,
  ).toBe(403);
});

it('SECURITY P1 refreshes a frozen input after a crash before any artifact was committed', async () => {
  putObject('w', 'source-version', 's', { value: 1 }, 0);
  let crash = true;
  const flow = new EcommerceWorkflow({
    freeze: (task) => {
      const revision = getObject('w', 'source-version', 's')!.revision;
      return {
        bound: {
          ...result(),
          task_id: task.id,
          input_revision: 'v' + revision,
        },
        products: [],
        evidence: [],
        rules: [],
        dependencies: [{ kind: 'source-version', id: 's', revision }],
        issues: [],
        data: {},
      };
    },
    fault: (phase) => {
      if (phase === 'after_freeze' && crash) {
        crash = false;
        throw new Error('simulated checkpoint crash');
      }
    },
    model: async ({ snapshot }) => ({
      text: JSON.stringify({
        ...snapshot.bound,
        status: 'needs_input',
        payload: null,
        claims: [],
        evidence: [],
        issues: [
          {
            code: 'MISSING',
            message: 'Need data',
            severity: 'blocking',
            field: null,
          },
        ],
        usage: emptyUsage(),
      }),
      usage: emptyUsage(),
    }),
  });
  const task = flow.startTask(
    'w',
    'owner',
    {
      task_type: 'listing_pack',
      market: 'US',
      locale: 'en-US',
      product_ids: ['p'],
    },
    'crash',
  );
  await flow.resumeTask('w', task.id);
  expect(flow.getTask('w', task.id).artifact).toBeNull();
  putObject('w', 'source-version', 's', { value: 2 }, 1);
  flow.reopenWithUpdatedInputs('w', task.id);
  await flow.resumeTask('w', task.id);
  expect(flow.getTask('w', task.id).snapshot?.bound.input_revision).toBe('v2');
});

it('SECURITY P1 excludes future-known competitor sources from a historical research task', () => {
  putObject('w', 'product', 'p', { ...product, facts: [] }, 0);
  const raw = Buffer.from('Future confidential candidate design');
  putSourceAsset(
    {
      workspace_id: 'w',
      source_id: 'future',
      kind: 'competitor',
      provenance: 'synthetic',
      owner_scope: 'w',
      market: 'US',
      locale: 'en-US',
      product_refs: [],
      observed_at: '2026-01-01T00:00:00Z',
      known_at: '2026-07-01T00:00:00Z',
      effective_from: null,
      effective_to: null,
      version: '1',
      content_hash: sha256(raw),
      rights_note: 'Synthetic',
      ingestion_status: 'ready',
      filename: 'future.txt',
      media_type: 'text/plain',
      byte_length: raw.length,
      source_url: null,
    },
    raw,
    raw.toString(),
  );
  const task = {
    id: 'historical',
    workspace_id: 'w',
    owner_id: 'owner',
    created_at: '2026-06-01T00:00:00Z',
    request: {
      task_type: 'research_brief',
      product_ids: ['p'],
      market: 'US',
      locale: 'en-US',
      asset_ids: ['future'],
      as_of: '2026-06-01T00:00:00Z',
    },
  } as WorkflowTask;
  let snapshot: FrozenInputs;
  try {
    snapshot = freezeTask(task);
  } catch {
    return;
  }
  expect(JSON.stringify(snapshot.data)).not.toContain(raw.toString());
});

function policySource(id: string, rule: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(rule));
  putSourceAsset(
    {
      workspace_id: 'w',
      source_id: id,
      kind: 'policy',
      provenance: 'synthetic',
      owner_scope: 'w',
      market: 'US',
      locale: 'en-US',
      product_refs: [],
      observed_at: '2020-01-01T00:00:00Z',
      known_at: '2020-01-01T00:00:00Z',
      effective_from: '2020-01-01T00:00:00Z',
      effective_to: null,
      version: '1',
      content_hash: sha256(raw),
      rights_note: 'Synthetic review policy',
      ingestion_status: 'ready',
      filename: id + '.json',
      media_type: 'application/json',
      byte_length: raw.length,
      source_url: null,
    },
    raw,
    raw.toString(),
  );
}
it('SECURITY P1 invalidates approval when a newly added applicable policy makes the frozen corpus conflicting', async () => {
  policySource('old-source', {
    listing_pack: { version: 'old', required_fields: ['/payload/title'] },
  });
  const old = ingestKnowledge('w', 'old-source', {
    id: 'old-policy',
    policy_id: 'title-policy',
    product_type: 'KETTLE',
    seller_scope: 'self',
    authority: 'official',
    approval_state: 'approved',
  });
  const value = artifactSeed(result());
  putObject(
    'w',
    'artifact',
    'a',
    {
      ...value,
      dependencies: [{ kind: 'knowledge', id: old.id, revision: 1 }],
    },
    1,
  );
  const a = app();
  expect(
    (
      await call(a, '/artifacts/a/review', 'POST', {
        workspace_id: 'w',
        expected_revision: 1,
        content_hash: value.content_hash,
        decision: 'approve',
        reason: 'Reviewed before policy addition',
        request_key: 'before-add',
      })
    ).status,
  ).toBe(200);
  policySource('new-source', {
    listing_pack: { version: 'new', banned_terms: ['1500 W'] },
  });
  expect(
    (
      await call(a, '/knowledge', 'POST', {
        workspace_id: 'w',
        asset_id: 'new-source',
        metadata: {
          id: 'new-policy',
          policy_id: 'title-policy',
          product_type: 'KETTLE',
          seller_scope: 'self',
          authority: 'official',
          approval_state: 'approved',
        },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call(
        a,
        '/artifacts/a/export?workspace_id=w&format=json&mode=approved',
      )
    ).status,
  ).toBe(403);
});

it('SECURITY P1 applies the resolved authority rather than reapplying the discarded experience policy', () => {
  putObject('w', 'product', 'p', { ...product, facts: [] }, 0);
  policySource('official-source', {
    listing_pack: { required_fields: ['/payload/title'] },
  });
  policySource('experience-source', {
    listing_pack: { banned_terms: ['1500 W'] },
  });
  ingestKnowledge('w', 'official-source', {
    id: 'official',
    policy_id: 'same-policy',
    product_type: 'KETTLE',
    seller_scope: 'self',
    authority: 'official',
    approval_state: 'approved',
  });
  ingestKnowledge('w', 'experience-source', {
    id: 'experience',
    policy_id: 'same-policy',
    product_type: 'KETTLE',
    seller_scope: 'self',
    authority: 'experience',
    approval_state: 'approved',
  });
  const task = {
    id: 'authority',
    workspace_id: 'w',
    owner_id: 'owner',
    created_at: '2026-06-01T00:00:00Z',
    request: {
      task_type: 'listing_pack',
      product_ids: ['p'],
      market: 'US',
      locale: 'en-US',
      as_of: '2026-06-01T00:00:00Z',
    },
  } as WorkflowTask;
  const frozen = freezeTask(task);
  expect(frozen.rules.flatMap((r) => r.banned_terms ?? [])).not.toContain(
    '1500 W',
  );
});

it('SECURITY P1 replays an identical HTTP import key despite the server recording a later receipt time', async () => {
  const a = app();
  const body = {
    workspace_id: 'w',
    name: 'manual.txt',
    text: 'Synthetic operating manual',
    metadata: {
      kind: 'product_fact',
      provenance: 'synthetic',
      market: 'US',
      locale: 'en-US',
      product_refs: [],
      observed_at: '2020-01-01T00:00:00Z',
      rights_note: 'Synthetic fixture',
    },
    request_key: 'same-upload',
  };
  const original = await call(a, '/assets', 'POST', body);
  expect(original.status).toBe(201);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const retry = await call(a, '/assets', 'POST', body);
  expect(retry.status).toBe(201);
  expect((await retry.json()).replayed).toBe(true);
});

it('SECURITY P1 isolates a single-output task from another same-market SKU specifications', async () => {
  const other: Product = {
    ...product,
    id: 'p2',
    sku: 'US-2000',
    facts: [
      {
        field: 'power',
        value: 2000,
        unit: 'W',
        evidence_id: 'other-power',
        verification_state: 'confirmed',
      },
    ],
  };
  const otherEvidence: Evidence = {
    ...evidence,
    evidence_id: 'other-power',
    source_id: 'other',
    excerpt: 'US-2000 rated power 2000 W',
  };
  const draft = result();
  draft.product_refs.push({
    product_id: other.id,
    sku: other.sku,
    market: 'US',
    revision: '1',
  });
  draft.payload!.title = 'US 2000 W';
  draft.payload!.bullets = ['2000 W'];
  draft.payload!.description = '2000 W';
  draft.evidence = [evidence, otherEvidence];
  draft.claims = ['title', 'bullets/0', 'description'].map((field) => ({
    claim_id: field,
    text: '2000 W',
    field_path: '/payload/' + field,
    evidence_refs: ['other-power'],
  }));
  expect(
    validateQuality(draft, {
      products: [product, other],
      evidence: draft.evidence,
    }).some((i) => i.severity === 'blocking'),
  ).toBe(true);
  putObject('w', 'product', product.id, product, 0);
  putObject('w', 'product', other.id, other, 0);
  const a = app();
  for (const task_type of ['listing_pack', 'ad_pack', 'support_draft']) {
    const response = await call(a, '/tasks', 'POST', {
      workspace_id: 'w',
      task_type,
      market: 'US',
      locale: 'en-US',
      product_ids: [product.id, other.id],
      request_key: 'mixed-' + task_type,
    });
    expect(response.status).toBe(400);
  }
});

it('SECURITY P1 checks product voltage in support replies against the single confirmed SKU', () => {
  const voltageEvidence: Evidence = {
    ...evidence,
    evidence_id: 'own-voltage',
    excerpt: 'US rated voltage 120 V',
  };
  const usProduct: Product = {
    ...product,
    facts: [
      {
        field: 'voltage',
        value: 120,
        unit: 'V',
        evidence_id: 'own-voltage',
        verification_state: 'confirmed',
      },
    ],
  };
  const draft = result('support_draft');
  draft.payload = {
    ticket_id: 'ticket',
    intent: 'usage',
    action: 'reply_draft',
    reply_body: 'This heater is rated 230 V.',
    order_evidence_refs: [],
    internal_notes_zh: ['请人工审核此回复。'],
  };
  draft.evidence = [voltageEvidence];
  draft.claims = [];
  expect(
    validateQuality(draft, {
      products: [usProduct],
      evidence: [voltageEvidence],
    }).some((i) => i.severity === 'blocking'),
  ).toBe(true);
});

it('QUALITY FR03 allows a supported candidate specification without assigning it to the own product', () => {
  const candidateEvidence: Evidence = {
    ...evidence,
    evidence_id: 'candidate-power',
    source_id: 'candidate',
    kind: 'competitor',
    excerpt: 'Competitor power 2000 W',
  };
  const draft = result('research_brief');
  draft.payload = {
    candidates: [
      {
        candidate_ref: 'candidate',
        supported_facts: ['Competitor power 2000 W'],
        differences: [],
        missing_evidence: [],
      },
    ],
    comparison_summary: 'Compare only provided candidate evidence.',
    next_questions: [],
  };
  draft.claims = [
    {
      claim_id: 'candidate-power',
      text: 'Competitor power 2000 W',
      field_path: '/payload/candidates/0/supported_facts/0',
      evidence_refs: ['candidate-power'],
    },
  ];
  draft.evidence = [candidateEvidence];
  expect(
    validateQuality(draft, {
      products: [product],
      evidence: [candidateEvidence],
    }).filter((i) => i.severity === 'blocking'),
  ).toEqual([]);
});

it('SECURITY P1 requires every research field number to belong to that candidate claim evidence', () => {
  const candidateA: Evidence = {
    ...evidence,
    evidence_id: 'a-power',
    source_id: 'candidate-a',
    kind: 'competitor',
    excerpt: 'Competitor power 2000 W',
  };
  const candidateB: Evidence = {
    ...evidence,
    evidence_id: 'b-voltage',
    source_id: 'candidate-b',
    kind: 'competitor',
    excerpt: 'Competitor voltage 230 V',
  };
  const draft = result('research_brief');
  draft.payload = {
    candidates: [
      {
        candidate_ref: 'candidate-a',
        supported_facts: ['Competitor power 2000 W 230 V'],
        differences: [],
        missing_evidence: [],
      },
    ],
    comparison_summary: 'Compare only provided evidence.',
    next_questions: [],
  };
  draft.claims = [
    {
      claim_id: 'a-power',
      text: '2000 W',
      field_path: '/payload/candidates/0/supported_facts/0',
      evidence_refs: ['a-power'],
    },
  ];
  draft.evidence = [candidateA, candidateB];
  expect(
    validateQuality(draft, {
      products: [product],
      evidence: draft.evidence,
    }).some((i) => i.severity === 'blocking'),
  ).toBe(true);
});
