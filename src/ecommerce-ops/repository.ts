import { createHash } from 'node:crypto';
import type { Evidence, ObjectRecord, SourceAsset } from './domain.js';

interface Statement {
  run(...args: any[]): { changes: number };
  get(...args: any[]): any;
  all(...args: any[]): any[];
}
export interface EcommerceDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}
let database: EcommerceDatabase | null = null;
export class EcommerceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EcommerceError';
  }
}
function db(): EcommerceDatabase {
  if (!database)
    throw new EcommerceError(
      'storage_unavailable',
      'Ecommerce database is not initialized',
    );
  return database;
}
export const sha256 = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(',')}}`;
}
export function createEcommerceSchema(connection: EcommerceDatabase): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS ecommerce_objects (
      workspace_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,kind,id)
    );
    CREATE TABLE IF NOT EXISTS ecommerce_source_assets (
      workspace_id TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL,
      metadata TEXT NOT NULL, content_hash TEXT NOT NULL, raw BLOB NOT NULL,
      extracted_text TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,source_id,version)
    );
    CREATE INDEX IF NOT EXISTS idx_ecommerce_asset_hash ON ecommerce_source_assets(workspace_id,source_id,content_hash);
    CREATE TABLE IF NOT EXISTS ecommerce_evidence (
      workspace_id TEXT NOT NULL, evidence_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(workspace_id,evidence_id)
    );
  `);
}
export function bindEcommerceDatabase(
  connection: EcommerceDatabase | null,
): void {
  database = connection;
}
function requireId(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    value.includes('\0')
  )
    throw new EcommerceError('invalid_request', `Invalid ${label}`);
}
function objectRow<T>(row: any): ObjectRecord<T> | undefined {
  return row
    ? {
        id: row.id,
        revision: row.revision,
        body: JSON.parse(row.body) as T,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    : undefined;
}
export function putObject<T>(
  workspaceId: string,
  kind: string,
  id: string,
  body: T,
  expectedRevision?: number,
): ObjectRecord<T> {
  requireId(workspaceId, 'workspace');
  requireId(kind, 'kind');
  requireId(id, 'id');
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  )
    throw new EcommerceError('invalid_request', 'Invalid expected revision');
  const serialized = canonicalJson(body);
  if (serialized === undefined)
    throw new EcommerceError('invalid_request', 'Object body must be JSON');
  return transact(() => {
    const current = getObject<T>(workspaceId, kind, id);
    if (
      expectedRevision !== undefined &&
      expectedRevision !== (current?.revision ?? 0)
    )
      throw new EcommerceError('revision_conflict', 'Object revision changed', {
        current_revision: current?.revision ?? 0,
      });
    const revision = (current?.revision ?? 0) + 1;
    const now = new Date().toISOString();
    const createdAt = current?.created_at ?? now;
    db()
      .prepare(
        `INSERT INTO ecommerce_objects(workspace_id,kind,id,revision,body,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET
      revision=excluded.revision,body=excluded.body,updated_at=excluded.updated_at`,
      )
      .run(workspaceId, kind, id, revision, serialized, createdAt, now);
    return {
      id,
      revision,
      body: JSON.parse(serialized) as T,
      created_at: createdAt,
      updated_at: now,
    };
  });
}
export function getObject<T>(
  workspaceId: string,
  kind: string,
  id: string,
): ObjectRecord<T> | undefined {
  return objectRow<T>(
    db()
      .prepare(
        'SELECT * FROM ecommerce_objects WHERE workspace_id=? AND kind=? AND id=?',
      )
      .get(workspaceId, kind, id),
  );
}
export function listObjects<T>(
  workspaceId: string,
  kind: string,
): ObjectRecord<T>[] {
  return db()
    .prepare(
      'SELECT * FROM ecommerce_objects WHERE workspace_id=? AND kind=? ORDER BY created_at,id',
    )
    .all(workspaceId, kind)
    .map((row) => objectRow<T>(row)!);
}
export function transact<T>(fn: () => T): T {
  return db().transaction(() => {
    const result = fn();
    if (result && typeof (result as any).then === 'function')
      throw new EcommerceError(
        'invalid_transaction',
        'Transactions must be synchronous',
      );
    return result;
  })();
}
export function putSourceAsset(
  asset: SourceAsset,
  raw: Buffer,
  text: string,
): SourceAsset {
  requireId(asset.workspace_id, 'workspace');
  requireId(asset.source_id, 'source');
  requireId(asset.version, 'version');
  if (sha256(raw) !== asset.content_hash || raw.length !== asset.byte_length)
    throw new EcommerceError('hash_mismatch', 'Source hash or size mismatch');
  const serialized = canonicalJson(asset);
  return transact(() => {
    const current = readSourceAsset(
      asset.workspace_id,
      asset.source_id,
      asset.version,
    );
    if (current) {
      if (
        canonicalJson(current.asset) !== serialized ||
        !current.raw.equals(raw) ||
        current.text !== text
      )
        throw new EcommerceError(
          'immutable_conflict',
          'Source revision is immutable',
        );
      return current.asset;
    }
    db()
      .prepare(
        'INSERT INTO ecommerce_source_assets(workspace_id,source_id,version,metadata,content_hash,raw,extracted_text,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        asset.workspace_id,
        asset.source_id,
        asset.version,
        serialized,
        asset.content_hash,
        raw,
        text,
        new Date().toISOString(),
      );
    return { ...asset };
  });
}
export function readSourceAsset(
  workspaceId: string,
  sourceId: string,
  version?: string,
): { asset: SourceAsset; raw: Buffer; text: string } | undefined {
  const row =
    version === undefined
      ? db()
          .prepare(
            'SELECT * FROM ecommerce_source_assets WHERE workspace_id=? AND source_id=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(workspaceId, sourceId)
      : db()
          .prepare(
            'SELECT * FROM ecommerce_source_assets WHERE workspace_id=? AND source_id=? AND version=?',
          )
          .get(workspaceId, sourceId, version);
  if (!row) return undefined;
  if (sha256(row.raw) !== row.content_hash)
    throw new EcommerceError(
      'hash_mismatch',
      'Stored source failed integrity check',
    );
  return {
    asset: JSON.parse(row.metadata) as SourceAsset,
    raw: Buffer.from(row.raw),
    text: row.extracted_text,
  };
}
export function getSourceAsset(
  workspaceId: string,
  sourceId: string,
  version?: string,
): SourceAsset | undefined {
  return readSourceAsset(workspaceId, sourceId, version)?.asset;
}
export function listSourceAssets(workspaceId: string): SourceAsset[] {
  return db()
    .prepare(
      'SELECT metadata FROM ecommerce_source_assets WHERE workspace_id=? ORDER BY created_at,source_id,version',
    )
    .all(workspaceId)
    .map((row) => JSON.parse(row.metadata) as SourceAsset);
}
export function putEvidence(workspaceId: string, evidence: Evidence): Evidence {
  const asset = db()
    .prepare(
      'SELECT metadata FROM ecommerce_source_assets WHERE workspace_id=? AND source_id=? AND content_hash=?',
    )
    .get(workspaceId, evidence.source_id, evidence.content_hash);
  const metadata = asset
    ? (JSON.parse(asset.metadata) as SourceAsset)
    : undefined;
  if (
    !metadata ||
    metadata.kind !== evidence.kind ||
    metadata.provenance !== evidence.provenance ||
    !evidence.excerpt?.trim() ||
    !evidence.locator?.trim()
  )
    throw new EcommerceError(
      'invalid_evidence',
      'Evidence must point to a matching source in this workspace',
    );
  requireId(evidence.evidence_id, 'evidence');
  const existing = getEvidence(workspaceId, evidence.evidence_id);
  if (existing && canonicalJson(existing) !== canonicalJson(evidence))
    throw new EcommerceError('immutable_conflict', 'Evidence is immutable');
  db()
    .prepare(
      'INSERT OR IGNORE INTO ecommerce_evidence(workspace_id,evidence_id,body) VALUES(?,?,?)',
    )
    .run(workspaceId, evidence.evidence_id, canonicalJson(evidence));
  return { ...evidence };
}
export function getEvidence(
  workspaceId: string,
  id: string,
): Evidence | undefined {
  const row = db()
    .prepare(
      'SELECT body FROM ecommerce_evidence WHERE workspace_id=? AND evidence_id=?',
    )
    .get(workspaceId, id);
  return row ? (JSON.parse(row.body) as Evidence) : undefined;
}
