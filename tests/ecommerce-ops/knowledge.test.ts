import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
} from '../../src/ecommerce-ops/repository.js';
import { importAssets } from '../../src/ecommerce-ops/ingest.js';
import {
  ingestKnowledge,
  ensureKnowledgeScope,
  knowledgeScopeId,
  retrieveEvidence,
  resolvePolicy,
} from '../../src/ecommerce-ops/knowledge.js';
import { getObject } from '../../src/ecommerce-ops/repository.js';
import type { EvidenceScope } from '../../src/ecommerce-ops/domain.js';

let db: Database.Database;
const scope: EvidenceScope = {
  workspace_id: 'alice',
  market: 'US',
  locale: 'en-US',
  product_type: 'KETTLE',
  seller_scope: 'seller',
  product_refs: [],
  as_of: '2026-06-01T00:00:00Z',
  known_as_of: '2026-06-01T00:00:00Z',
};
beforeEach(() => {
  db = new Database(':memory:');
  createEcommerceSchema(db);
  bindEcommerceDatabase(db);
});
afterEach(() => {
  bindEcommerceDatabase(null);
  db.close();
});
async function policy(
  id: string,
  overrides: Record<string, unknown> = {},
  text = 'power voltage rules',
) {
  const meta = {
    kind: 'policy' as const,
    provenance: 'synthetic' as const,
    owner_scope: 'alice',
    market: 'US' as const,
    locale: 'en-US' as const,
    product_refs: [],
    observed_at: '2026-01-01T00:00:00Z',
    known_at: '2026-01-01T00:00:00Z',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    rights_note: 'Synthetic policy',
  };
  const result = await importAssets(
    'alice',
    [{ filename: `${id}.txt`, bytes: Buffer.from(text), metadata: meta }],
    {},
    `asset-${id}`,
  );
  return ingestKnowledge('alice', result.assets[0].source_id, {
    id,
    product_type: 'KETTLE',
    seller_scope: 'seller',
    authority: 'official',
    approval_state: 'approved',
    known_at: '2026-01-01T00:00:00Z',
    policy_id: id,
    ...overrides,
  });
}
describe('metadata-first applicable lexical evidence', () => {
  it('filters station, type, seller, known time, validity, product and approval before ranking', async () => {
    await policy('valid');
    await policy('expired', { effective_to: '2026-02-01T00:00:00Z' });
    await policy('future', { known_at: '2027-01-01T00:00:00Z' });
    await policy('pending', { approval_state: 'pending' });
    await policy('seller', { seller_scope: 'other' });
    await policy('type', { product_type: 'TOY' });
    await policy('product', {
      product_refs: [
        { product_id: 'other', sku: 'other', revision: '1', market: 'US' },
      ],
    });
    await policy('unknown', { effective_from: null });
    const result = retrieveEvidence('power voltage', scope);
    expect(result.retrieved_doc_refs.map((x) => x.id)).toEqual(['valid']);
    expect(result.evidence[0].locator).toMatch(/chars:/);
    expect(result.filtered.flatMap((x) => x.reasons)).toEqual(
      expect.arrayContaining([
        'expired',
        'not_yet_known',
        'not_approved',
        'wrong_seller_scope',
        'wrong_product_type',
        'wrong_product',
        'applicability_unknown',
      ]),
    );
    expect(
      retrieveEvidence('power', { ...scope, workspace_id: 'bob' }).evidence,
    ).toEqual([]);
    expect(
      retrieveEvidence('power', { ...scope, market: 'DE', locale: 'de-DE' })
        .evidence,
    ).toEqual([]);
  });

  it('prefers applicable official policy to more repetitive experience and returns at most five', async () => {
    await policy('official', {}, 'Power limit.');
    for (let n = 0; n < 7; n++)
      await policy(
        `experience-${n}`,
        { authority: 'experience', policy_id: `experience-${n}` },
        'power power power power power',
      );
    const bundle = retrieveEvidence('power', scope);
    expect(bundle.evidence).toHaveLength(5);
    expect(bundle.retrieved_doc_refs[0].id).toBe('official');
    expect(resolvePolicy(bundle, scope).status).toBe('resolved');
  });

  it('detects overlapping official policy revisions even when only one enters lexical top K', async () => {
    await policy('one', { policy_id: 'title-rule' }, 'power requirement');
    await policy(
      'two',
      { policy_id: 'title-rule' },
      'an unrelated title condition',
    );
    const bundle = retrieveEvidence('power', scope, 1);
    const result = resolvePolicy(bundle, scope);
    expect(result.status).toBe('conflict');
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policy_id: 'title-rule',
          document_ids: ['one', 'two'],
        }),
      ]),
    );
  });

  it('will not grant policy authority to an asset labeled competitor, or read cross-workspace assets', async () => {
    const batch = await importAssets(
      'alice',
      [
        {
          filename: 'c.txt',
          bytes: Buffer.from('Competitor claims'),
          metadata: {
            kind: 'competitor',
            provenance: 'synthetic',
            owner_scope: 'alice',
            market: 'US',
            locale: 'en-US',
            product_refs: [],
            observed_at: '2026-01-01T00:00:00Z',
            known_at: '2026-01-01T00:00:00Z',
            rights_note: 'Synthetic',
          },
        },
      ],
      {},
      'c',
    );
    expect(() =>
      ingestKnowledge('alice', batch.assets[0].source_id, {
        id: 'c',
        kind: 'policy',
        product_type: 'KETTLE',
        seller_scope: 'seller',
        authority: 'official',
        approval_state: 'approved',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_scope' }));
    expect(() =>
      ingestKnowledge('bob', batch.assets[0].source_id, {
        id: 'c',
        product_type: 'KETTLE',
        seller_scope: 'seller',
        authority: 'official',
        approval_state: 'approved',
      }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  it('replays the policy revision that was known then after a later withdrawal', async () => {
    const original = await policy('mutable');
    ingestKnowledge(
      'alice',
      original.asset_id,
      {
        id: 'mutable',
        product_type: 'KETTLE',
        seller_scope: 'seller',
        authority: 'official',
        approval_state: 'withdrawn',
        known_at: '2026-07-01T00:00:00Z',
      },
      1,
    );
    const historical = retrieveEvidence('power', scope);
    expect(historical.retrieved_doc_refs[0]).toMatchObject({
      id: 'mutable',
      revision: 1,
    });
    expect(
      retrieveEvidence('power', {
        ...scope,
        known_as_of: '2026-08-01T00:00:00Z',
      }).evidence,
    ).toEqual([]);
  });

  it('cannot broaden a SKU-specific source into a general policy by clearing product refs', async () => {
    const productRefs = [
      { product_id: 'us-p', sku: 'US', revision: '1', market: 'US' as const },
    ];
    const batch = await importAssets(
      'alice',
      [
        {
          filename: 'restricted.txt',
          bytes: Buffer.from('SKU specific power rule'),
          metadata: {
            kind: 'policy',
            provenance: 'synthetic',
            owner_scope: 'alice',
            market: 'US',
            locale: 'en-US',
            product_refs: productRefs,
            observed_at: '2026-01-01T00:00:00Z',
            known_at: '2026-01-01T00:00:00Z',
            effective_from: '2026-01-01T00:00:00Z',
            rights_note: 'Synthetic',
          },
        },
      ],
      {},
      'restricted',
    );
    const metadata = {
      id: 'restricted',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      authority: 'official' as const,
      approval_state: 'approved' as const,
      known_at: '2026-01-01T00:00:00Z',
    };
    expect(() =>
      ingestKnowledge('alice', batch.assets[0].source_id, {
        ...metadata,
        product_refs: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_scope' }));
    const result = ingestKnowledge(
      'alice',
      batch.assets[0].source_id,
      metadata,
    );
    expect(result.product_refs).toEqual(productRefs);
    expect(retrieveEvidence('power', scope).evidence).toEqual([]);
    expect(
      retrieveEvidence('power', { ...scope, product_refs: productRefs })
        .evidence,
    ).toHaveLength(1);
  });

  it('versions the applicable knowledge collection atomically, including an initially empty scope', async () => {
    const before = ensureKnowledgeScope('alice', scope);
    expect(before.id).toBe(knowledgeScopeId('US', 'KETTLE', 'seller'));
    expect(before.body.epoch).toBe(0);
    const doc = await policy('epoch');
    const after = ensureKnowledgeScope('alice', scope);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.body.epoch).toBe(1);
    expect(ensureKnowledgeScope('bob', scope).body.epoch).toBe(0);
    expect(() =>
      ingestKnowledge(
        'alice',
        doc.asset_id,
        {
          id: doc.id,
          product_type: 'KETTLE',
          seller_scope: 'seller',
          authority: 'official',
          approval_state: 'withdrawn',
          known_at: '2026-02-01T00:00:00Z',
        },
        0,
      ),
    ).toThrow();
    expect(getObject('alice', 'knowledge_scope', before.id)?.revision).toBe(
      after.revision,
    );
    ingestKnowledge(
      'alice',
      doc.asset_id,
      {
        id: doc.id,
        product_type: 'KETTLE',
        seller_scope: 'seller',
        authority: 'official',
        approval_state: 'withdrawn',
        known_at: '2026-02-01T00:00:00Z',
      },
      1,
    );
    expect(ensureKnowledgeScope('alice', scope).body.epoch).toBe(2);
  });
});
