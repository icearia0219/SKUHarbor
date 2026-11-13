import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as repository from '../../src/ecommerce-ops/repository.js';
import type { SourceAsset } from '../../src/ecommerce-ops/domain.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  repository.createEcommerceSchema(db);
  repository.bindEcommerceDatabase(db);
});
afterEach(() => {
  repository.bindEcommerceDatabase(null);
  db.close();
});

describe('same-connection ecommerce repository', () => {
  it('isolates composite IDs, enforces CAS, and retains original creation time', () => {
    const a = repository.putObject(
      'alice',
      'product',
      'same',
      { sku: 'US' },
      0,
    );
    const b = repository.putObject('bob', 'product', 'same', { sku: 'DE' }, 0);
    expect(a.revision).toBe(1);
    expect(b.body.sku).toBe('DE');
    expect(repository.getObject('mallory', 'product', 'same')).toBeUndefined();
    expect(() =>
      repository.putObject('alice', 'product', 'same', {}, 0),
    ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
    expect(() =>
      repository.putObject('alice', 'product', 'same', {}, 7),
    ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
    const next = repository.putObject(
      'alice',
      'product',
      'same',
      { sku: 'US-2' },
      1,
    );
    expect(next.revision).toBe(2);
    expect(next.created_at).toBe(a.created_at);
    expect(repository.listObjects('alice', 'product')).toHaveLength(1);
  });

  it('rolls back multiple business objects as one transaction', () => {
    expect(() =>
      repository.transact(() => {
        repository.putObject('alice', 'artifact', 'a', { ok: true }, 0);
        repository.putObject('alice', 'review', 'b', { approved: true }, 0);
        throw new Error('crash before checkpoint');
      }),
    ).toThrow('crash');
    expect(repository.listObjects('alice', 'artifact')).toEqual([]);
    expect(repository.listObjects('alice', 'review')).toEqual([]);
  });

  it('keeps immutable raw evidence above 64 KiB with exact hash and workspace isolation', () => {
    const raw = Buffer.from('原文'.repeat(30_000));
    const asset: SourceAsset = {
      workspace_id: 'alice',
      source_id: 'manual',
      kind: 'product_fact',
      provenance: 'synthetic',
      owner_scope: 'alice',
      market: 'US',
      locale: 'en-US',
      product_refs: [],
      observed_at: '2026-01-01T00:00:00Z',
      effective_from: null,
      effective_to: null,
      known_at: '2026-01-01T00:00:00Z',
      version: '1',
      content_hash: createHash('sha256').update(raw).digest('hex'),
      rights_note: 'Synthetic test',
      ingestion_status: 'ready',
      filename: 'manual.txt',
      media_type: 'text/plain',
      byte_length: raw.length,
      source_url: null,
    };
    repository.putSourceAsset(asset, raw, raw.toString('utf8'));
    expect(repository.listSourceAssets('alice')).toEqual([asset]);
    expect(repository.listSourceAssets('bob')).toEqual([]);
    expect(
      repository.readSourceAsset('alice', 'manual', '1')?.raw.equals(raw),
    ).toBe(true);
    expect(repository.readSourceAsset('bob', 'manual', '1')).toBeUndefined();
    expect(() =>
      repository.putSourceAsset(
        { ...asset, rights_note: 'rewritten' },
        raw,
        raw.toString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'immutable_conflict' }));
    expect(() =>
      repository.putSourceAsset(
        { ...asset, version: '2', content_hash: 'forged' },
        raw,
        raw.toString(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'hash_mismatch' }));
    expect(
      repository.getSourceAsset('alice', 'manual', '1')?.content_hash,
    ).toBe(asset.content_hash);
  });

  it('stores immutable evidence only when the same workspace contains its hashed source', () => {
    const evidence = {
      evidence_id: 'e',
      source_id: 'missing',
      kind: 'product_fact' as const,
      locator: 'row:1',
      content_hash: 'x',
      provenance: 'synthetic' as const,
      excerpt: 'power 1500 W',
    };
    expect(() => repository.putEvidence('alice', evidence)).toThrowError(
      expect.objectContaining({ code: 'invalid_evidence' }),
    );
  });

  it('reopens durable objects and includes raw BLOBs in a self-contained SQLite backup', () => {
    const temporary = mkdtempSync(
      path.join(os.tmpdir(), 'ecommerce-repository-'),
    );
    const file = path.join(temporary, 'business.db');
    let disk = new Database(file);
    try {
      repository.createEcommerceSchema(disk);
      repository.bindEcommerceDatabase(disk);
      repository.putObject('alice', 'artifact', 'a', { text: 'persisted' }, 0);
      const raw = Buffer.from('large evidence'.repeat(10_000));
      repository.putSourceAsset(
        {
          workspace_id: 'alice',
          source_id: 'raw',
          kind: 'policy',
          provenance: 'synthetic',
          owner_scope: 'alice',
          market: 'US',
          locale: 'en-US',
          product_refs: [],
          observed_at: '2026-01-01T00:00:00Z',
          effective_from: null,
          effective_to: null,
          known_at: '2026-01-01T00:00:00Z',
          version: '1',
          content_hash: repository.sha256(raw),
          rights_note: 'Synthetic',
          ingestion_status: 'ready',
          filename: 'policy.txt',
          media_type: 'text/plain',
          byte_length: raw.length,
          source_url: null,
        },
        raw,
        raw.toString(),
      );
      disk.close();
      disk = new Database(file);
      repository.bindEcommerceDatabase(disk);
      expect(repository.getObject('alice', 'artifact', 'a')?.body).toEqual({
        text: 'persisted',
      });
      expect(
        repository.readSourceAsset('alice', 'raw', '1')?.raw.equals(raw),
      ).toBe(true);
      const backup = path.join(temporary, 'backup.db');
      disk.prepare('VACUUM INTO ?').run(backup);
      const probe = new Database(backup, { readonly: true });
      try {
        expect(probe.pragma('quick_check', { simple: true })).toBe('ok');
        expect(
          (
            probe.prepare('SELECT raw FROM ecommerce_source_assets').get() as {
              raw: Buffer;
            }
          ).raw.equals(raw),
        ).toBe(true);
      } finally {
        probe.close();
      }
    } finally {
      repository.bindEcommerceDatabase(db);
      disk.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
