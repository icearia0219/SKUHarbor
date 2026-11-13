import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
  getSourceAsset,
  putSourceAsset,
  sha256,
} from '../../src/ecommerce-ops/repository.js';
import { importAssets } from '../../src/ecommerce-ops/ingest.js';
import {
  ingestKnowledge,
  retrieveEvidence,
  resolvePolicy,
} from '../../src/ecommerce-ops/knowledge.js';
import { createEcommerceRoutes } from '../../src/ecommerce-ops/routes.js';
import type {
  EvidenceScope,
  SourceAsset,
} from '../../src/ecommerce-ops/domain.js';

let db: Database.Database;
const initial = '2026-01-01T00:00:00Z';
const metadata = {
  kind: 'policy' as const,
  provenance: 'synthetic' as const,
  owner_scope: 'review',
  market: 'US' as const,
  locale: 'en-US' as const,
  product_refs: [],
  observed_at: initial,
  known_at: initial,
  effective_from: initial,
  effective_to: null,
  rights_note: 'Synthetic in-memory code review fixture',
};
const scope: EvidenceScope = {
  workspace_id: 'review',
  market: 'US',
  locale: 'en-US',
  product_type: 'KETTLE',
  seller_scope: 'seller',
  product_refs: [],
  as_of: '2026-01-01T12:00:00Z',
  known_as_of: '2026-01-01T12:00:00Z',
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(initial));
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
  vi.useRealTimers();
});

async function source() {
  const batch = await importAssets(
    'review',
    [{ filename: 'policy.txt', bytes: Buffer.from('power policy'), metadata }],
    {},
    'policy-source',
  );
  return batch.assets[0].source_id;
}

it('experience-only policy cannot satisfy authoritative policy coverage', async () => {
  const id = await source();
  ingestKnowledge('review', id, {
    id: 'experience-only',
    product_type: 'KETTLE',
    seller_scope: 'seller',
    authority: 'experience',
    approval_state: 'approved',
  });
  const result = resolvePolicy(retrieveEvidence('power', scope), scope);
  expect(result.status).toBe('unknown');
  expect(result.policy_snapshot_id).toBeNull();
});

it('knowledge updates cannot reuse old known time or rewrite a historical query', async () => {
  const id = await source();
  const definition = {
    id: 'current',
    product_type: 'KETTLE',
    seller_scope: 'seller',
    authority: 'official' as const,
    approval_state: 'approved' as const,
  };
  const original = ingestKnowledge('review', id, definition);
  expect(retrieveEvidence('power', scope).evidence).toHaveLength(1);
  vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
  expect(() =>
    ingestKnowledge(
      'review',
      id,
      {
        ...definition,
        approval_state: 'withdrawn',
        known_at: original.known_at,
      },
      1,
    ),
  ).toThrow();
  const updated = ingestKnowledge(
    'review',
    id,
    { ...definition, approval_state: 'withdrawn' },
    1,
  );
  expect(Date.parse(updated.known_at)).toBeGreaterThan(
    Date.parse(original.known_at),
  );
  expect(retrieveEvidence('power', scope).evidence).toHaveLength(1);
  expect(
    retrieveEvidence('power', { ...scope, known_as_of: '2026-01-03T00:00:00Z' })
      .evidence,
  ).toHaveLength(0);
});

it('latest source selection uses actual insertion sequence for same-time versions 9 and 10', () => {
  for (const version of ['9', '10']) {
    const bytes = Buffer.from(`version ${version}`);
    const asset: SourceAsset = {
      ...metadata,
      workspace_id: 'review',
      source_id: 'versioned',
      version,
      content_hash: sha256(bytes),
      ingestion_status: 'ready',
      filename: 'source.txt',
      media_type: 'text/plain',
      byte_length: bytes.length,
      source_url: null,
    };
    putSourceAsset(asset, bytes, bytes.toString());
  }
  expect(getSourceAsset('review', 'versioned')?.version).toBe('10');
  expect(getSourceAsset('review', 'versioned', '9')?.version).toBe('9');
});

it('the public asset route replays an identical upload despite a later server clock', async () => {
  const app = createEcommerceRoutes({
    auth: async (c, next) => {
      c.set('user', { id: 'review' } as any);
      await next();
    },
    authorize: () => {},
    enabled: () => true,
  });
  const body = {
    workspace_id: 'review',
    name: 'duplicate.txt',
    text: 'Repeated synthetic input',
    metadata,
    request_key: 'stable-upload-key',
  };
  const request = () =>
    app.request('/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const first = await request();
  expect(first.status).toBe(201);
  const firstResult = await first.json();
  vi.setSystemTime(new Date(Date.parse(initial) + 15));
  const second = await request();
  expect(second.status).toBe(201);
  const secondResult = await second.json();
  expect(secondResult.replayed).toBe(true);
  expect(secondResult.assets[0].known_at).toBe(firstResult.assets[0].known_at);
});
