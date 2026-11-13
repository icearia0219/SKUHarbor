import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type {
  Evidence,
  Market,
  Locale,
  ProductRef,
  TaskType,
} from './domain.js';

export interface Issue {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  field: string | null;
}
export interface Claim {
  claim_id: string;
  text: string;
  field_path: string;
  evidence_refs: string[];
}
export interface Usage {
  model_ref: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  retry_count: number;
  model_elapsed_ms: number | null;
  cost_usd: number | null;
  price_version: string | null;
}
export interface BoundTaskContext {
  task_id: string;
  task_type: TaskType;
  workspace_id: string;
  market: Market;
  locale: Locale;
  as_of: string;
  product_refs: ProductRef[];
  input_revision: string;
  policy_snapshot_id: string | null;
}
export interface TaskResult extends BoundTaskContext {
  schema_version: '1.0';
  status: 'draft' | 'needs_input' | 'blocked' | 'failed';
  payload: Record<string, unknown> | null;
  claims: Claim[];
  evidence: Evidence[];
  issues: Issue[];
  usage: Usage;
}
export const emptyUsage = (): Usage => ({
  model_ref: null,
  input_tokens: null,
  output_tokens: null,
  retry_count: 0,
  model_elapsed_ms: null,
  cost_usd: null,
  price_version: null,
});
export const issue = (
  code: string,
  message: string,
  field: string | null = null,
  severity: Issue['severity'] = 'blocking',
): Issue => ({ code, severity, message, field });
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat(
  'date-time',
  (s: string) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
    Number.isFinite(Date.parse(s)),
);
const schema = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../docs/ecommerce-ops/contracts/task-result.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const check = ajv.compile(schema);
export function validateTaskResult(
  value: unknown,
  bound: BoundTaskContext,
): { ok: true; result: TaskResult } | { ok: false; errors: string[] } {
  if (!check(value))
    return {
      ok: false,
      errors: (check.errors ?? []).map(
        (e) => `${e.instancePath}: ${e.message}`,
      ),
    };
  const result = value as TaskResult;
  const errors = Object.keys(bound)
    .filter(
      (k) =>
        canonical(result[k as keyof TaskResult]) !==
        canonical(bound[k as keyof BoundTaskContext]),
    )
    .map((k) => `BOUND_CONTEXT_MISMATCH:${k}`);
  return errors.length ? { ok: false, errors } : { ok: true, result };
}
export function failureResult(
  bound: BoundTaskContext,
  status: TaskResult['status'],
  issues: Issue[],
  evidence: Evidence[] = [],
  usage = emptyUsage(),
): TaskResult {
  return {
    ...bound,
    schema_version: '1.0',
    status,
    payload: null,
    claims: [],
    evidence,
    issues,
    usage,
  };
}
export function normalizeFieldPath(path: string): string {
  if (path.startsWith('/')) return path;
  if (!/^payload(?:(?:\.[A-Za-z0-9_-]+)|(?:\[\d+\]))+$/.test(path)) return '';
  return (
    '/' +
    path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .join('/')
  );
}
export function pointer(value: unknown, path: string): unknown {
  path = normalizeFieldPath(path);
  if (!path.startsWith('/')) return undefined;
  let current: unknown = value;
  for (const key of path
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      current === null ||
      typeof current !== 'object'
    )
      return undefined;
    current = Object.hasOwn(current, key)
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }
  return current;
}
