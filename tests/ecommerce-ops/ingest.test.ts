import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEcommerceSchema,
  bindEcommerceDatabase,
  readSourceAsset,
  listObjects,
} from '../../src/ecommerce-ops/repository.js';
import {
  importAssets,
  extractAssetText,
} from '../../src/ecommerce-ops/ingest.js';

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
  rights_note: 'Self authored fixture',
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

describe('authorized-asset ingestion', () => {
  it('preserves complete text and returns per-row CSV mapping errors without losing valid rows', async () => {
    const full = '额外说明'.repeat(20_000);
    const result = await importAssets(
      'alice',
      [
        { filename: 'manual.txt', bytes: Buffer.from(full), metadata: meta },
        {
          filename: 'spec.csv',
          bytes: Buffer.from(
            'sku,field,value,unit\nUS,power,1500,W\nUS,power,not-a-number,W\n',
          ),
          metadata: meta,
        },
      ],
      { value_type: 'number' },
      'request-1',
    );
    expect(
      readSourceAsset('alice', result.assets[0].source_id, '1')?.text,
    ).toBe(full);
    expect(result.rows).toHaveLength(1);
    expect(result.row_errors).toEqual([
      expect.objectContaining({ row: 3, code: 'invalid_value' }),
    ]);
    expect(result.rows[0].fact.verification_state).toBe('candidate');
    const replay = await importAssets(
      'alice',
      [
        { filename: 'manual.txt', bytes: Buffer.from(full), metadata: meta },
        {
          filename: 'spec.csv',
          bytes: Buffer.from(
            'sku,field,value,unit\nUS,power,1500,W\nUS,power,not-a-number,W\n',
          ),
          metadata: meta,
        },
      ],
      { value_type: 'number' },
      'request-1',
    );
    expect(replay.assets.map((a) => a.source_id)).toEqual(
      result.assets.map((a) => a.source_id),
    );
    expect(replay.replayed).toBe(true);
    await expect(
      importAssets(
        'alice',
        [
          {
            filename: 'x.txt',
            bytes: Buffer.from('different'),
            metadata: meta,
          },
        ],
        {},
        'request-1',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('rejects inconsistent market/locale, ownership and empty/scanned extraction', async () => {
    await expect(
      importAssets(
        'alice',
        [
          {
            filename: 'a.txt',
            bytes: Buffer.from('power'),
            metadata: { ...meta, locale: 'de-DE' },
          },
        ],
        {},
        'a',
      ),
    ).rejects.toMatchObject({ code: 'invalid_scope' });
    await expect(
      importAssets(
        'alice',
        [
          {
            filename: 'a.txt',
            bytes: Buffer.from('power'),
            metadata: { ...meta, owner_scope: 'bob' },
          },
        ],
        {},
        'b',
      ),
    ).rejects.toMatchObject({ code: 'invalid_scope' });
    await expect(
      extractAssetText('scan.pdf', Buffer.from('%PDF-fake'), {
        pdf: async () => '',
      }),
    ).rejects.toMatchObject({ code: 'empty_extraction' });
    await expect(
      extractAssetText('blank.txt', Buffer.from('  ')),
    ).rejects.toMatchObject({ code: 'empty_extraction' });
    expect(listObjects('alice', 'import')).toHaveLength(0);
  });

  it('extracts bounded DOCX XML without executing entities and rejects unsafe archives', async () => {
    const valid = new AdmZip();
    valid.addFile(
      'word/document.xml',
      Buffer.from(
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Power &amp; voltage</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
    expect(
      (await extractAssetText('manual.docx', valid.toBuffer())).text,
    ).toContain('Power & voltage');
    const unsafe = new AdmZip();
    unsafe.addFile(
      'word/document.xml',
      Buffer.from(
        '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><w:t>&e;</w:t>',
      ),
    );
    await expect(
      extractAssetText('unsafe.docx', unsafe.toBuffer()),
    ).rejects.toMatchObject({ code: 'unsafe_document' });
    const excessive = new AdmZip();
    excessive.addFile('word/document.xml', Buffer.from('x'.repeat(300_000)));
    await expect(
      extractAssetText('large.docx', excessive.toBuffer(), {
        max_extracted_bytes: 100_000,
      }),
    ).rejects.toMatchObject({ code: 'document_too_large' });
    const malformed = new AdmZip();
    malformed.addFile(
      'word/document.xml',
      Buffer.from('<w:document><w:t>unclosed text'),
    );
    await expect(
      extractAssetText('malformed.docx', malformed.toBuffer()),
    ).rejects.toMatchObject({ code: 'unsafe_document' });
  });

  it('handles quoted CSV fields and malformed records explicitly', async () => {
    const result = await importAssets(
      'alice',
      [
        {
          filename: 'facts.csv',
          bytes: Buffer.from(
            'sku,field,value,unit\nUS,name,"Kettle, Blue",\nUS,label,"bad\n',
          ),
          metadata: meta,
        },
      ],
      {},
      'csv',
    );
    expect(result.rows[0].fact.value).toBe('Kettle, Blue');
    expect(result.row_errors).toContainEqual(
      expect.objectContaining({ code: 'malformed_csv' }),
    );
  });

  it('accepts safe XLSX report bytes without falsely decoding them as text or product facts', async () => {
    const spreadsheet = new AdmZip();
    spreadsheet.addFile('xl/workbook.xml', Buffer.from('<workbook/>'));
    const raw = spreadsheet.toBuffer();
    const result = await importAssets(
      'alice',
      [
        {
          filename: 'report.xlsx',
          bytes: raw,
          metadata: { ...meta, kind: 'report' },
        },
      ],
      {},
      'report',
    );
    expect(result.rows).toEqual([]);
    const saved = readSourceAsset('alice', result.assets[0].source_id, '1');
    expect(saved?.raw.equals(raw)).toBe(true);
    expect(saved?.text).toBe('');
    await expect(
      importAssets(
        'alice',
        [{ filename: 'facts.xlsx', bytes: raw, metadata: meta }],
        {},
        'not-report',
      ),
    ).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('stores policy JSON as a knowledge document and respects per-row declared scalar types', async () => {
    const result = await importAssets(
      'alice',
      [
        {
          filename: 'ptd.json',
          bytes: Buffer.from('{"properties":{"title":{"maxLength":100}}}'),
          metadata: { ...meta, kind: 'policy' },
        },
        {
          filename: 'typed.csv',
          bytes: Buffer.from(
            'sku,field,value,unit,value_type\nUS,power,1500,W,number\nUS,automatic,true,,boolean\n',
          ),
          metadata: meta,
        },
      ],
      {},
      'typed',
    );
    expect(result.rows.map((r) => r.fact.value)).toEqual([1500, true]);
    expect(
      readSourceAsset('alice', result.assets[0].source_id, '1')?.text,
    ).toContain('maxLength');
  });
});
