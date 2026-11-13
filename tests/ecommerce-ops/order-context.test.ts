import { it, expect } from 'vitest';
import { approvedOrderContext } from '../../src/ecommerce-ops/tasks/order-context.js';
const input = () => ({
  workspace_id: 'w',
  market: 'US',
  ticket_id: 't',
  approved: true,
  asset: {
    workspace_id: 'w',
    source_id: 'order',
    kind: 'order',
    market: 'US',
    provenance: 'synthetic',
    content_hash: 'hash',
    version: '1',
  } as any,
  raw: {
    workspace_id: 'w',
    market: 'US',
    ticket_id: 't',
    observed_at: '2026-11-12T01:00:00Z',
    valid_until: '2026-11-14T01:00:00Z',
    ownership_verified: true,
    customer_email: 'private@example.invalid',
    refund: { state: 'requested', receipt: { verified: true } },
  },
});
it('requires an explicitly approved, scoped order import', () => {
  expect(() => approvedOrderContext({ ...input(), approved: false })).toThrow();
  expect(() =>
    approvedOrderContext({ ...input(), workspace_id: 'other' }),
  ).toThrow();
});
it('does not promote a requested refund or raw verified boolean into completion', () => {
  const x = approvedOrderContext(input());
  expect(x.order?.refund?.state).toBe('requested');
  expect(x.order?.refund?.receipt).toBeUndefined();
  expect(JSON.stringify(x)).not.toContain('private@example.invalid');
});
it('binds a completed receipt to source evidence only after human import approval', () => {
  const i = input();
  i.raw.refund = {
    state: 'completed',
    receipt: { id: 'private-receipt', completed_at: '2026-11-12T00:00:00Z' },
  } as any;
  const x = approvedOrderContext(i);
  expect(x.order?.refund?.receipt?.verified).toBe(true);
  expect(x.order?.evidence_refs).toContain(
    x.order?.refund?.receipt?.evidence_ref,
  );
  expect(
    x.evidence.some(
      (e) =>
        e.locator.endsWith('/refund/state') && e.excerpt.includes('completed'),
    ),
  ).toBe(true);
  expect(JSON.stringify(x)).not.toContain('private-receipt');
});
