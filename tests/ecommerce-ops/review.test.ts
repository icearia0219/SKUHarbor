import Database from 'better-sqlite3';
import fs from 'node:fs';
import { beforeEach, afterEach, it, expect } from 'vitest';
import {
  createEcommerceSchema,
  bindEcommerceDatabase,
  putObject,
  getObject,
} from '../../src/ecommerce-ops/repository.js';
import { hash } from '../../src/ecommerce-ops/contracts.js';
import {
  reviewArtifact,
  exportArtifact,
  editArtifact,
} from '../../src/ecommerce-ops/review.js';
import type { Artifact } from '../../src/ecommerce-ops/workflow.js';
let db: InstanceType<typeof Database>, a: Artifact;
beforeEach(() => {
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
  const result = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../docs/ecommerce-ops/examples/structured-output.example.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  result.workspace_id = 'w';
  a = {
    id: 'a',
    workspace_id: 'w',
    task_id: 't',
    revision: 1,
    content_hash: hash(result),
    input_revision: result.input_revision,
    policy_snapshot_id: result.policy_snapshot_id,
    result,
    stale: false,
    quality: [],
    dependencies: [],
    review: null,
    created_at: '2026-11-12T00:00:00Z',
    updated_at: '2026-11-12T00:00:00Z',
  };
  putObject('w', 'artifact', 'a', a, 0);
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
});
it('requires exact hash/version and human decision, with idempotency', () => {
  expect(() =>
    reviewArtifact('w', 'a', 1, 'wrong', 'approve', 'why', 'human', 'key'),
  ).toThrow();
  const r = reviewArtifact(
    'w',
    'a',
    1,
    a.content_hash,
    'approve',
    'checked',
    'human',
    'key',
  );
  expect(r.review?.valid).toBe(true);
  expect(
    reviewArtifact(
      'w',
      'a',
      1,
      a.content_hash,
      'approve',
      'checked',
      'human',
      'key',
    ).revision,
  ).toBe(1);
});
it.each(['blocked', 'failed', 'needs_input'])(
  'rejects direct approval of %s results',
  (status) => {
    a.result.status = status as any;
    a.result.payload = null;
    putObject('w', 'artifact', 'a', a, 1);
    expect(() =>
      reviewArtifact(
        'w',
        'a',
        1,
        a.content_hash,
        'approve',
        'checked',
        'human',
        'blocked',
      ),
    ).toThrow();
  },
);
it('B17 stale dependencies and serious quality errors cannot be approved', () => {
  for (const value of [
    { ...a, stale: true },
    {
      ...a,
      quality: [
        {
          code: 'FACT_CONFLICT',
          severity: 'blocking',
          message: 'conflict',
          field: null,
        },
      ],
    },
  ]) {
    putObject('w', 'artifact', 'a', value);
    expect(() =>
      reviewArtifact(
        'w',
        'a',
        1,
        a.content_hash,
        'approve',
        'checked',
        'human',
        'bad',
      ),
    ).toThrow();
  }
});
it('B18 edited content invalidates old approval and requires re-quality/review', () => {
  reviewArtifact(
    'w',
    'a',
    1,
    a.content_hash,
    'approve',
    'checked',
    'human',
    'approved',
  );
  const edited = editArtifact(
    'w',
    'a',
    1,
    { ...a.result.payload, title: 'Edited 2000 W' },
    () => [
      {
        code: 'UNSUPPORTED_CLAIM',
        severity: 'blocking',
        message: 'wrong power',
        field: '/payload/title',
      },
    ],
  );
  expect(edited.revision).toBe(2);
  expect(edited.review).toBeNull();
  expect(() => exportArtifact('w', 'a', 2, 'json', 'approved')).toThrow();
  expect(() =>
    reviewArtifact(
      'w',
      'a',
      1,
      a.content_hash,
      'approve',
      'checked',
      'human',
      'approved',
    ),
  ).toThrow('REVISION_CONFLICT');
});
it('B22 preview and approved exports are canonical and label current status', () => {
  const preview = JSON.parse(
    exportArtifact('w', 'a', 1, 'json', 'preview').content,
  );
  expect(preview.delivery_status).toBe('unreviewed_preview');
  reviewArtifact(
    'w',
    'a',
    1,
    a.content_hash,
    'approve',
    'checked',
    'human',
    'ok',
  );
  const json = JSON.parse(
    exportArtifact('w', 'a', 1, 'json', 'approved').content,
  );
  const md = exportArtifact('w', 'a', 1, 'markdown', 'approved').content;
  expect(json.result.payload.title).toBe(a.result.payload!.title);
  expect(md).toContain(String(json.result.payload.title));
  expect(() => exportArtifact('other', 'a', 1, 'json', 'preview')).toThrow();
});

it('B22 round-trips diagnosis CSV values and null denominators from the same reviewed JSON', () => {
  a.result.task_type = 'ads_diagnosis';
  a.result.claims = [];
  a.result.payload = {
    report_id: 'r',
    metrics_ref: 'm',
    metrics: {
      currency: 'USD',
      spend_minor: 101,
      attributed_sales_minor: 0,
      impressions: 0,
      clicks: 0,
      attributed_orders: 0,
      acos_ratio: null,
      roas: 0,
      ctr_ratio: null,
      cpc_minor: null,
      cvr_ratio: null,
    },
    maturity: 'complete',
    findings: [],
    missing_context: [],
  };
  a.content_hash = hash(a.result);
  putObject('w', 'artifact', 'a', a, 1);
  reviewArtifact(
    'w',
    'a',
    1,
    a.content_hash,
    'approve',
    'Checked synthetic zero denominators',
    'human',
    'csv',
  );
  const json = JSON.parse(
    exportArtifact('w', 'a', 1, 'json', 'approved').content,
  );
  const lines = exportArtifact('w', 'a', 1, 'csv', 'approved')
    .content.trimEnd()
    .split('\r\n');
  const rows = lines
    .slice(1)
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?=,|$)/g)].map((match) =>
        match[1].replace(/""/g, '"'),
      ),
    );
  expect(rows.find((r) => r[3] === 'spend_minor')?.slice(4)).toEqual([
    String(json.result.payload.metrics.spend_minor),
    'minor_unit',
  ]);
  expect(rows.find((r) => r[3] === 'acos_ratio')?.slice(4)).toEqual([
    '',
    'ratio',
  ]);
  expect(rows.find((r) => r[3] === 'roas')?.slice(4)).toEqual(['0', 'ratio']);
});
