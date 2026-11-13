import { describe, it, expect } from 'vitest';
import { validateQuality } from '../../src/ecommerce-ops/quality.js';
import { hash } from '../../src/ecommerce-ops/contracts.js';
import type { TaskResult } from '../../src/ecommerce-ops/contracts.js';
import type { Product, Evidence } from '../../src/ecommerce-ops/domain.js';
const e: Evidence = {
  evidence_id: 'e1',
  source_id: 'own',
  kind: 'product_fact',
  locator: '/facts/power',
  content_hash: hash('1500 W'),
  provenance: 'synthetic',
  excerpt: '1500 W',
};
const p: Product = {
  id: 'p1',
  workspace_id: 'w',
  sku: 'US-1',
  market: 'US',
  locale: 'en-US',
  product_type: 'heater',
  seller_scope: 'self',
  revision: 1,
  facts: [
    {
      field: 'power',
      value: 1500,
      unit: 'W',
      evidence_id: 'e1',
      verification_state: 'confirmed',
    },
  ],
};
const r = (): TaskResult => ({
  schema_version: '1.0',
  workspace_id: 'w',
  task_id: 't',
  task_type: 'listing_pack',
  market: 'US',
  locale: 'en-US',
  as_of: '2026-11-12T00:00:00Z',
  product_refs: [
    { product_id: 'p1', sku: 'US-1', revision: '1', market: 'US' },
  ],
  input_revision: 'i',
  policy_snapshot_id: 'policy',
  status: 'draft',
  payload: {
    title: 'Heater 1500 W',
    bullets: ['1500 W'],
    description: '1500 W',
    search_terms: [],
    rule_coverage: 'partial',
    unchecked_rules: ['Not full Amazon approval'],
  },
  evidence: [e],
  claims: ['title', 'bullets/0', 'description'].map((field) => ({
    claim_id: field,
    text: '1500 W',
    field_path: '/payload/' + field,
    evidence_refs: ['e1'],
  })),
  issues: [],
  usage: {
    model_ref: null,
    input_tokens: null,
    output_tokens: null,
    retry_count: 0,
    model_elapsed_ms: null,
    cost_usd: null,
    price_version: null,
  },
});
describe('business evidence and quality gates', () => {
  it('rejects wrong SKU specifications even when claim is omitted', () => {
    const x = r();
    x.payload!.title = 'Heater 2000 W';
    x.claims = [];
    expect(
      validateQuality(x, { products: [p], evidence: [e] }).some(
        (v) => v.code === 'UNSUPPORTED_CLAIM',
      ),
    ).toBe(true);
  });
  it('rejects invented or mutated evidence, not merely missing URLs', () => {
    const x = r();
    x.evidence[0] = { ...e, excerpt: '2000 W' };
    expect(
      validateQuality(x, { products: [p], evidence: [e] }).some(
        (v) => v.code === 'EVIDENCE_MISMATCH',
      ),
    ).toBe(true);
  });
  it('rejects competitor certification as own certification', () => {
    const x = r();
    x.payload!.title = 'CE certified heater';
    const competitor = {
      ...e,
      kind: 'competitor' as const,
      excerpt: 'CE certified',
    };
    x.evidence = [competitor];
    expect(
      validateQuality(x, { products: [p], evidence: [competitor] }).some(
        (v) => v.code === 'UNSUPPORTED_CLAIM',
      ),
    ).toBe(true);
  });
  it('uses rule version field limits instead of global title length', () => {
    const x = r();
    expect(
      validateQuality(x, {
        products: [p],
        evidence: [e],
        rules: [
          { version: 'v1', limits: { '/payload/title': { max_chars: 5 } } },
        ],
      }).some((v) => v.code === 'FIELD_LIMIT'),
    ).toBe(true);
  });
  it('requires claims on material content and real field pointers', () => {
    const x = r();
    x.claims[0].field_path = '/payload/no_such_field';
    expect(
      validateQuality(x, { products: [p], evidence: [e] }).some(
        (v) => v.code === 'CLAIM_LOCATION',
      ),
    ).toBe(true);
  });
  it('validates supported 1500 W and distinct 2000 W contexts', () => {
    expect(
      validateQuality(r(), { products: [p], evidence: [e] }).filter(
        (v) => v.severity === 'blocking',
      ),
    ).toEqual([]);
  });
  it('blocks a draft when an applicable versioned profile requires an unknown product fact', () => {
    expect(
      validateQuality(r(), {
        products: [p],
        evidence: [e],
        rules: [
          { version: 'synthetic', required_facts: ['power', 'voltage'] } as any,
        ],
      }).some((i) => i.code === 'UNKNOWN_REQUIRED_FACT'),
    ).toBe(true);
    expect(
      validateQuality(r(), {
        products: [p],
        evidence: [e],
        rules: [{ version: 'synthetic', required_facts: ['power'] } as any],
      }).filter((i) => i.severity === 'blocking'),
    ).toEqual([]);
  });
  it('checks schema-valid dot paths with the same field evidence requirements as JSON pointers', () => {
    const x = r();
    x.claims = x.claims.map((c) => ({
      ...c,
      field_path: c.field_path.slice(1).replaceAll('/', '.'),
    }));
    expect(
      validateQuality(x, { products: [p], evidence: [e] }).filter(
        (i) => i.severity === 'blocking',
      ),
    ).toEqual([]);
    x.payload!.title = '2000 W';
    expect(
      validateQuality(x, { products: [p], evidence: [e] }).some(
        (i) => i.code === 'UNSUPPORTED_CLAIM',
      ),
    ).toBe(true);
  });
  it('does not change a candidate watt value into a voltage using another source unit', () => {
    const x = r();
    x.task_type = 'research_brief';
    const a = {
        ...e,
        evidence_id: 'candidate',
        source_id: 'candidate',
        kind: 'competitor' as const,
        excerpt: '2000 W',
      },
      b = {
        ...e,
        evidence_id: 'other',
        source_id: 'other',
        kind: 'competitor' as const,
        excerpt: '230 V',
      };
    x.evidence = [a, b];
    x.payload = {
      candidates: [
        {
          candidate_ref: 'candidate',
          supported_facts: ['2000 V'],
          differences: [],
          missing_evidence: [],
        },
      ],
      comparison_summary: 'Comparison',
      next_questions: [],
    };
    x.claims = [
      {
        claim_id: 'a',
        text: '2000 V',
        field_path: '/payload/candidates/0/supported_facts/0',
        evidence_refs: ['candidate'],
      },
    ];
    expect(
      validateQuality(x, { products: [p], evidence: [a, b] }).some(
        (v) => v.severity === 'blocking',
      ),
    ).toBe(true);
  });
});
