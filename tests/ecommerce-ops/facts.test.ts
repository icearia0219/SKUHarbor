import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindEcommerceDatabase,
  createEcommerceSchema,
} from '../../src/ecommerce-ops/repository.js';
import { importAssets } from '../../src/ecommerce-ops/ingest.js';
import {
  createProduct,
  confirmFacts,
  freezeInputs,
  getProduct,
  stageFactCandidates,
} from '../../src/ecommerce-ops/facts.js';

let db: Database.Database;
const meta = {
  kind: 'product_fact' as const,
  provenance: 'synthetic' as const,
  owner_scope: 'alice',
  market: 'US' as const,
  locale: 'en-US' as const,
  product_refs: [],
  observed_at: '2026-01-01T00:00:00Z',
  known_at: '2026-01-01T00:00:00Z',
  rights_note: 'Synthetic',
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

async function candidate(
  value: number,
  kind: 'product_fact' | 'competitor' = 'product_fact',
) {
  const batch = await importAssets(
    'alice',
    [
      {
        filename: 'facts.json',
        bytes: Buffer.from(
          JSON.stringify([{ sku: 'US', field: 'power', value, unit: 'W' }]),
        ),
        metadata: { ...meta, kind },
      },
    ],
    {},
    `source-${value}-${kind}`,
  );
  return batch.rows[0].fact;
}

describe('product facts and frozen versions', () => {
  it('requires explicit human reason and CAS, preserving candidates until confirmed', async () => {
    const fact = await candidate(1500);
    const product = createProduct({
      id: 'p',
      workspace_id: 'alice',
      sku: 'US',
      market: 'US',
      locale: 'en-US',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      facts: [fact],
    });
    expect(product.revision).toBe(1);
    expect(() =>
      confirmFacts(
        'alice',
        'p',
        1,
        [{ evidence_id: fact.evidence_id, decision: 'confirm', reason: '' }],
        'human',
      ),
    ).toThrowError(expect.objectContaining({ code: 'confirmation_required' }));
    const next = confirmFacts(
      'alice',
      'p',
      1,
      [
        {
          evidence_id: fact.evidence_id,
          decision: 'confirm',
          reason: 'Checked specification',
        },
      ],
      'human',
    );
    expect(next.facts[0].verification_state).toBe('confirmed');
    expect(next.revision).toBe(2);
    expect(() => confirmFacts('alice', 'p', 1, [], 'human')).toThrowError(
      expect.objectContaining({ code: 'revision_conflict' }),
    );
    expect(getProduct('bob', 'p')).toBeUndefined();
    const frozen = freezeInputs({
      workspace_id: 'alice',
      product_ids: ['p'],
      market: 'US',
      locale: 'en-US',
      as_of: '2026-01-02T00:00:00Z',
    });
    expect(frozen.product_refs[0]).toMatchObject({
      product_id: 'p',
      revision: '2',
      market: 'US',
    });
    expect(frozen.evidence).toHaveLength(1);
  });

  it('blocks conflicting confirmed fields and cross-market products', async () => {
    const a = await candidate(1500),
      b = await candidate(2000);
    createProduct({
      id: 'p',
      workspace_id: 'alice',
      sku: 'US',
      market: 'US',
      locale: 'en-US',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      facts: [a, b],
    });
    confirmFacts(
      'alice',
      'p',
      1,
      [a, b].map((f) => ({
        evidence_id: f.evidence_id,
        decision: 'confirm' as const,
        reason: 'Checked',
      })),
      'human',
    );
    expect(() =>
      freezeInputs({
        workspace_id: 'alice',
        product_ids: ['p'],
        market: 'US',
        locale: 'en-US',
        as_of: '2026-01-02T00:00:00Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'FACT_CONFLICT' }));
    expect(() =>
      freezeInputs({
        workspace_id: 'alice',
        product_ids: ['p'],
        market: 'DE',
        locale: 'de-DE',
        as_of: '2026-01-02T00:00:00Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'WRONG_MARKET' }));
  });

  it('refuses competitor specifications as confirmed own-product facts', async () => {
    const fact = await candidate(1500, 'competitor');
    createProduct({
      id: 'p',
      workspace_id: 'alice',
      sku: 'US',
      market: 'US',
      locale: 'en-US',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      facts: [fact],
    });
    expect(() =>
      confirmFacts(
        'alice',
        'p',
        1,
        [
          {
            evidence_id: fact.evidence_id,
            decision: 'confirm',
            reason: 'Copied competitor',
          },
        ],
        'human',
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CLAIM' }));
  });

  it('stages imported candidates once, rejects forged values and preserves immutable product snapshots', async () => {
    const fact = await candidate(1500);
    createProduct({
      id: 'p',
      workspace_id: 'alice',
      sku: 'US',
      market: 'US',
      locale: 'en-US',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      facts: [],
    });
    expect(() =>
      stageFactCandidates('alice', 'p', 1, [{ ...fact, value: 2000 }]),
    ).toThrowError(expect.objectContaining({ code: 'invalid_evidence' }));
    const staged = stageFactCandidates('alice', 'p', 1, [fact, fact]);
    expect(staged.revision).toBe(2);
    expect(staged.facts).toHaveLength(1);
    expect(stageFactCandidates('alice', 'p', 2, [fact]).revision).toBe(2);
    expect(
      stageFactCandidates('alice', 'p', 2, [fact, fact]).facts,
    ).toHaveLength(1);
    confirmFacts(
      'alice',
      'p',
      2,
      [
        {
          evidence_id: fact.evidence_id,
          decision: 'confirm',
          reason: 'Original specification verified',
        },
      ],
      'human',
    );
    const frozen = freezeInputs({
      workspace_id: 'alice',
      product_ids: ['p'],
      market: 'US',
      locale: 'en-US',
      as_of: '2026-01-02T00:00:00Z',
    });
    confirmFacts(
      'alice',
      'p',
      3,
      [
        {
          evidence_id: fact.evidence_id,
          decision: 'reject',
          reason: 'Withdrawn after reinspection',
        },
      ],
      'human',
    );
    expect(frozen.products[0].facts[0].verification_state).toBe('confirmed');
    expect(getProduct('alice', 'p')?.facts[0].verification_state).toBe(
      'rejected',
    );
  });

  it('blocks a future-known product source during historical freeze', async () => {
    const batch = await importAssets(
      'alice',
      [
        {
          filename: 'future.json',
          bytes: Buffer.from(
            JSON.stringify([
              { sku: 'US', field: 'power', value: 1500, unit: 'W' },
            ]),
          ),
          metadata: { ...meta, known_at: '2026-02-01T00:00:00Z' },
        },
      ],
      {},
      'future',
    );
    const fact = batch.rows[0].fact;
    createProduct({
      id: 'p',
      workspace_id: 'alice',
      sku: 'US',
      market: 'US',
      locale: 'en-US',
      product_type: 'KETTLE',
      seller_scope: 'seller',
      facts: [fact],
    });
    confirmFacts(
      'alice',
      'p',
      1,
      [
        {
          evidence_id: fact.evidence_id,
          decision: 'confirm',
          reason: 'Verified',
        },
      ],
      'human',
    );
    expect(() =>
      freezeInputs({
        workspace_id: 'alice',
        product_ids: ['p'],
        market: 'US',
        locale: 'en-US',
        as_of: '2026-01-02T00:00:00Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'FUTURE_EVIDENCE' }));
  });

  it('retains an explicitly bound source product identity when attaching candidate facts', async () => {
    const batch = await importAssets(
      'alice',
      [
        {
          filename: 'bound.json',
          bytes: Buffer.from(
            JSON.stringify([
              { sku: 'US', field: 'power', value: 1500, unit: 'W' },
            ]),
          ),
          metadata: {
            ...meta,
            product_refs: [
              {
                product_id: 'original-product',
                sku: 'US',
                revision: '1',
                market: 'US',
              },
            ],
          },
        },
      ],
      {},
      'bound',
    );
    expect(() =>
      createProduct({
        id: 'different-product',
        workspace_id: 'alice',
        sku: 'US',
        market: 'US',
        locale: 'en-US',
        product_type: 'KETTLE',
        seller_scope: 'seller',
        facts: [batch.rows[0].fact],
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_evidence' }));
  });
});
