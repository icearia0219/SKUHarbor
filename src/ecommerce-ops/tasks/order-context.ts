import type { SupportInput } from './support.js';
import type { SourceAsset, Evidence } from '../domain.js';
import { hash } from '../contracts.js';
export function approvedOrderContext(input: {
  raw: unknown;
  asset: SourceAsset;
  approved: boolean;
  ticket_id: string;
  workspace_id: string;
  market: string;
}): { order: SupportInput['order']; evidence: Evidence[] } {
  const { asset } = input,
    raw = input.raw as Record<string, unknown>;
  if (
    !input.approved ||
    asset.kind !== 'order' ||
    asset.workspace_id !== input.workspace_id ||
    asset.market !== input.market ||
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw.workspace_id !== undefined &&
      raw.workspace_id !== input.workspace_id) ||
    (raw.market !== undefined && raw.market !== input.market) ||
    (raw.ticket_id !== undefined && raw.ticket_id !== input.ticket_id)
  )
    throw new Error('ORDER_SCOPE_MISMATCH');
  const instant = (value: unknown) =>
    typeof value === 'string' &&
    /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value));
  if (!instant(raw.observed_at) || !instant(raw.valid_until))
    throw new Error('ORDER_TIME_REQUIRED');
  const evidence: Evidence[] = [];
  const field = (path: string, value: unknown) => {
    const ref =
      'order-ev-' + hash([asset.source_id, asset.version, path, value]);
    evidence.push({
      evidence_id: ref,
      source_id: asset.source_id,
      kind: 'order',
      locator: `version:${asset.version};json:${path}`,
      content_hash: asset.content_hash,
      provenance: asset.provenance,
      excerpt: JSON.stringify(value),
    });
    return ref;
  };
  field('/observed_at', raw.observed_at);
  field('/valid_until', raw.valid_until);
  field('/ownership_verified', raw.ownership_verified === true);
  const effect = (
    name: 'refund' | 'replacement',
  ): NonNullable<SupportInput['order']>['refund'] => {
    const value = raw[name] as Record<string, unknown> | undefined;
    if (!value) return undefined;
    if (
      !['requested', 'pending', 'accepted', 'completed'].includes(
        String(value.state),
      )
    )
      throw new Error('ORDER_EFFECT_STATE_INVALID');
    const state = value.state as
        | 'requested'
        | 'pending'
        | 'accepted'
        | 'completed',
      ref = field('/' + name + '/state', state);
    const receipt = value.receipt as Record<string, unknown> | undefined;
    // Approval is a human attestation of an imported record, not a platform action.
    // Never trust the incoming receipt.verified boolean or arbitrary evidence IDs.
    if (
      state === 'completed' &&
      receipt &&
      typeof receipt.id === 'string' &&
      receipt.id.trim() &&
      instant(receipt.completed_at)
    ) {
      field('/' + name + '/receipt/completed_at', receipt.completed_at);
      return {
        state,
        receipt: {
          id: 'import-receipt-' + hash(receipt.id).slice(0, 24),
          verified: true,
          evidence_ref: ref,
          completed_at: receipt.completed_at as string,
        },
      };
    }
    return { state };
  };
  const refund = effect('refund'),
    replacement = effect('replacement');
  return {
    order: {
      workspace_id: input.workspace_id,
      ownership_verified: raw.ownership_verified === true,
      observed_at: raw.observed_at as string,
      valid_until: raw.valid_until as string,
      evidence_refs: evidence.map((e) => e.evidence_id),
      ...(refund ? { refund } : {}),
      ...(replacement ? { replacement } : {}),
    },
    evidence,
  };
}
