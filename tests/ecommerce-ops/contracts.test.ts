import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  validateTaskResult,
  pointer,
} from '../../src/ecommerce-ops/contracts.js';

const example = () =>
  JSON.parse(
    fs.readFileSync(
      new URL(
        '../../docs/ecommerce-ops/examples/structured-output.example.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
const context = (v: any) => ({
  task_id: v.task_id,
  task_type: v.task_type,
  workspace_id: v.workspace_id,
  market: v.market,
  locale: v.locale,
  as_of: v.as_of,
  input_revision: v.input_revision,
  policy_snapshot_id: v.policy_snapshot_id,
  product_refs: v.product_refs,
});

describe('shared ecommerce output contract', () => {
  it('resolves documented JSON pointers and schema-valid dotted payload paths without prototype traversal', () => {
    const v = { payload: { bullets: ['1500 W'] } };
    expect(pointer(v, '/payload/bullets/0')).toBe('1500 W');
    expect(pointer(v, 'payload.bullets.0')).toBe('1500 W');
    expect(pointer(v, 'payload.bullets[0]')).toBe('1500 W');
    expect(pointer(v, 'payload.__proto__.constructor')).toBeUndefined();
  });
  it('accepts the supplied synthetic listing without inventing approval', () => {
    const v = example();
    expect(validateTaskResult(v, context(v)).ok).toBe(true);
  });
  it.each(['approved', 'extra'])('rejects an extra model field %s', (key) => {
    const v = example();
    v[key] = true;
    expect(validateTaskResult(v, context(v)).ok).toBe(false);
  });
  it('rejects cross-workspace/model-chosen task identifiers', () => {
    const v = example();
    const bound = context(v);
    v.workspace_id = 'other';
    expect(validateTaskResult(v, bound).ok).toBe(false);
  });
  it('rejects wrong payload, null draft and unsupported locales', () => {
    for (const change of [
      { payload: null },
      { task_type: 'ad_pack' },
      { locale: 'de-DE' },
      { status: 'approved' },
    ]) {
      const v = { ...example(), ...change };
      expect(validateTaskResult(v, context(v)).ok).toBe(false);
    }
  });
  it('validates actual date-time syntax and bounded arrays', () => {
    const v = example();
    v.as_of = 'today';
    expect(validateTaskResult(v, context(v)).ok).toBe(false);
  });
  it('requires a blocking result to explain the failure', () => {
    const v = example();
    v.status = 'needs_input';
    v.payload = null;
    v.issues = [];
    expect(validateTaskResult(v, context(v)).ok).toBe(false);
  });
});
