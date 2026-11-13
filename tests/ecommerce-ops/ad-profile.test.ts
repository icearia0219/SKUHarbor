import { it, expect } from 'vitest';
import { validateBusinessResult } from '../../src/ecommerce-ops/service.js';
import { emptyUsage } from '../../src/ecommerce-ops/contracts.js';
const snapshot: any = { rules: [], data: { placement: 'internal_draft' } };
const result: any = {
  task_type: 'ad_pack',
  workspace_id: 'w',
  task_id: 't',
  status: 'draft',
  payload: {
    placement: 'internal_draft',
    copies: [{ headline: '1500 W', body: '1500 W', cta: 'View' }],
    keywords: [],
    rule_coverage: 'internal_draft',
    unchecked_rules: ['No placement profile'],
  },
  usage: emptyUsage(),
};
it('does not let the model claim a placement profile was checked when none applies', () => {
  const x = structuredClone(result);
  x.payload.rule_coverage = 'profile_checked';
  x.payload.unchecked_rules = [];
  expect(
    validateBusinessResult(x, snapshot, 'w', 't').some(
      (i) => i.code === 'PLACEMENT_PROFILE_MISSING',
    ),
  ).toBe(true);
});
it('binds ad output to the requested placement instead of a model-chosen format', () => {
  const x = structuredClone(result);
  x.payload.placement = 'arbitrary-marketplace';
  expect(
    validateBusinessResult(x, snapshot, 'w', 't').some(
      (i) => i.code === 'PLACEMENT_MISMATCH',
    ),
  ).toBe(true);
});
it('allows an explicitly limited internal draft, and an exact matching profile', () => {
  expect(validateBusinessResult(result, snapshot, 'w', 't')).toEqual([]);
  const x = structuredClone(result);
  x.payload.rule_coverage = 'profile_checked';
  expect(
    validateBusinessResult(
      x,
      {
        ...snapshot,
        rules: [{ placement: 'internal_draft', version: 'synthetic' }],
      },
      'w',
      't',
    ),
  ).toEqual([]);
});
it('distinguishes an immature-period prohibition from an actual recommendation', () => {
  const s: any = {
    data: {
      metrics: { currency: 'USD' },
      maturity: 'incomplete',
      metrics_ref: 'm',
      report_id: 'r',
    },
    rules: [],
  };
  const x: any = {
    status: 'draft',
    task_type: 'ads_diagnosis',
    payload: {
      metrics: s.data.metrics,
      maturity: 'incomplete',
      metrics_ref: 'm',
      report_id: 'r',
      findings: [
        {
          message:
            'Data is incomplete; do not add negative keywords or stop campaigns.',
          action_draft: null,
        },
      ],
    },
  };
  expect(validateBusinessResult(x, s, 'w', 't')).toEqual([]);
  x.payload.findings[0].action_draft = 'Pause this campaign.';
  expect(
    validateBusinessResult(x, s, 'w', 't').some(
      (i) => i.code === 'ATTRIBUTION_INCOMPLETE',
    ),
  ).toBe(true);
});
