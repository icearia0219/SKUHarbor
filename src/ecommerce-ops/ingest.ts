import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { ProductFact, SourceAsset } from './domain.js';
import {
  canonicalJson,
  EcommerceError,
  getObject,
  putEvidence,
  putObject,
  putSourceAsset,
  sha256,
  transact,
} from './repository.js';

const execute = promisify(execFile);
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024;
export type AssetMetadata = Pick<
  SourceAsset,
  | 'kind'
  | 'provenance'
  | 'owner_scope'
  | 'market'
  | 'locale'
  | 'product_refs'
  | 'observed_at'
  | 'rights_note'
> &
  Partial<
    Pick<
      SourceAsset,
      | 'source_id'
      | 'version'
      | 'known_at'
      | 'effective_from'
      | 'effective_to'
      | 'source_url'
    >
  >;
export interface AssetInput {
  filename: string;
  bytes: Buffer | Uint8Array;
  metadata: AssetMetadata;
}
export interface ImportMapping {
  sku?: string;
  field?: string;
  value?: string;
  unit?: string;
  value_type?: 'string' | 'number' | 'boolean';
}
export interface ImportRow {
  source_id: string;
  row: number;
  sku: string;
  fact: ProductFact;
}
export interface ImportRowError {
  source_id: string;
  row: number;
  code: string;
  message: string;
}
export interface ImportBatchResult {
  batch_id: string;
  assets: SourceAsset[];
  rows: ImportRow[];
  row_errors: ImportRowError[];
  replayed: boolean;
}
export interface ExtractionOptions {
  pdf?: (bytes: Buffer) => Promise<string>;
  max_extracted_bytes?: number;
  max_asset_bytes?: number;
  allow_binary_report?: boolean;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  )
    throw new EcommerceError('invalid_metadata', `Invalid ${label}`);
  return new Date(value).toISOString();
}
function checkMetadata(workspaceId: string, metadata: AssetMetadata): void {
  if (
    !metadata ||
    metadata.owner_scope !== workspaceId ||
    !['US', 'DE'].includes(metadata.market) ||
    metadata.locale !== (metadata.market === 'US' ? 'en-US' : 'de-DE')
  )
    throw new EcommerceError(
      'invalid_scope',
      'Owner, market and locale must match the selected workspace scope',
    );
  if (
    ![
      'product_fact',
      'policy',
      'brand',
      'competitor',
      'report',
      'order',
      'ticket',
      'experience',
    ].includes(metadata.kind) ||
    !['real', 'redacted', 'synthetic', 'public'].includes(
      metadata.provenance,
    ) ||
    !metadata.rights_note?.trim()
  )
    throw new EcommerceError(
      'invalid_metadata',
      'Source kind, provenance and rights are required',
    );
  if (
    !Array.isArray(metadata.product_refs) ||
    metadata.product_refs.some(
      (r) =>
        !r.product_id || !r.sku || !r.revision || r.market !== metadata.market,
    )
  )
    throw new EcommerceError(
      'invalid_scope',
      'Source product references must match the source market',
    );
  timestamp(metadata.observed_at, 'observed_at');
  if (metadata.known_at) timestamp(metadata.known_at, 'known_at');
  if (metadata.effective_from)
    timestamp(metadata.effective_from, 'effective_from');
  if (metadata.effective_to) timestamp(metadata.effective_to, 'effective_to');
  if (
    metadata.effective_from &&
    metadata.effective_to &&
    Date.parse(metadata.effective_from) >= Date.parse(metadata.effective_to)
  )
    throw new EcommerceError(
      'invalid_metadata',
      'Source validity interval is empty',
    );
}
function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '');
  } catch {
    throw new EcommerceError(
      'invalid_encoding',
      'Document must contain valid UTF-8',
    );
  }
}
function xmlText(xml: string): string {
  if (/<!\s*(DOCTYPE|ENTITY)|<\?\s*(?!xml\s)/i.test(xml))
    throw new EcommerceError(
      'unsafe_document',
      'DTD, entities and processing instructions are unsupported',
    );
  const decode = (text: string): string => {
    const output: string[] = [];
    let cursor = 0;
    for (;;) {
      const start = text.indexOf('&', cursor);
      if (start < 0) {
        output.push(text.slice(cursor));
        break;
      }
      output.push(text.slice(cursor, start));
      const end = text.indexOf(';', start + 1);
      if (end < 0 || end - start > 16)
        throw new EcommerceError('unsafe_document', 'Malformed XML entity');
      const entity = text.slice(start + 1, end);
      const escaped: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      if (Object.hasOwn(escaped, entity)) output.push(escaped[entity]);
      else {
        const code = /^#x[0-9a-f]+$/i.test(entity)
          ? parseInt(entity.slice(2), 16)
          : /^#\d+$/.test(entity)
            ? Number(entity.slice(1))
            : NaN;
        if (
          !Number.isInteger(code) ||
          code <= 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        )
          throw new EcommerceError('unsafe_document', 'Unsupported XML entity');
        output.push(String.fromCodePoint(code));
      }
      cursor = end + 1;
    }
    return output.join('');
  };
  const parts: string[] = [];
  let cursor = 0,
    inText = false;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) {
      if (inText)
        throw new EcommerceError(
          'unsafe_document',
          'Unclosed DOCX text element',
        );
      break;
    }
    if (inText) parts.push(decode(xml.slice(cursor, start)));
    if (xml.startsWith('<!--', start)) {
      if (inText)
        throw new EcommerceError('unsafe_document', 'Nested DOCX text markup');
      const end = xml.indexOf('-->', start + 4);
      if (end < 0)
        throw new EcommerceError('unsafe_document', 'Unclosed XML comment');
      cursor = end + 3;
      continue;
    }
    const end = xml.indexOf('>', start + 1);
    if (end < 0)
      throw new EcommerceError('unsafe_document', 'Unclosed XML tag');
    const tag = xml.slice(start + 1, end).trim();
    if (inText) {
      if (!/^\/w:t\s*$/.test(tag))
        throw new EcommerceError(
          'unsafe_document',
          'Nested or malformed DOCX text',
        );
      inText = false;
    } else if (/^w:t(?:\s|$)/.test(tag) && !tag.endsWith('/')) inText = true;
    else if (/^\/w:p\s*$|^w:br(?:\s|\/|$)/.test(tag)) parts.push('\n');
    else if (/^w:tab(?:\s|\/|$)/.test(tag)) parts.push('\t');
    cursor = end + 1;
  }
  if (inText)
    throw new EcommerceError('unsafe_document', 'Unclosed DOCX text element');
  return parts.join('');
}
function checkedArchive(bytes: Buffer, limit: number): AdmZip {
  let archive: AdmZip;
  try {
    archive = new AdmZip(bytes);
  } catch {
    throw new EcommerceError('unsafe_document', 'Invalid Office ZIP archive');
  }
  const entries = archive.getEntries();
  if (!entries.length || entries.length > 2048)
    throw new EcommerceError('unsafe_document', 'Invalid ZIP entry count');
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (
      /^[\/]|^[a-z]:|(^|[\/])\.\.([\/]|$)|\0/i.test(name) ||
      names.has(name) ||
      entry.header.encrypted ||
      ![0, 8].includes(entry.header.method) ||
      ((entry.attr >>> 16) & 0xf000) === 0xa000
    )
      throw new EcommerceError(
        'unsafe_document',
        'Unsafe or duplicate Office ZIP entry',
      );
    names.add(name);
    if (
      !Number.isSafeInteger(entry.header.size) ||
      entry.header.size < 0 ||
      (!entry.isDirectory &&
        entry.header.size === 0 &&
        entry.header.compressedSize > 2)
    )
      throw new EcommerceError('unsafe_document', 'Invalid expanded ZIP size');
    total += entry.header.size;
    if (total > limit * 2 || entry.header.size > limit)
      throw new EcommerceError(
        'document_too_large',
        'Expanded Office document exceeds the extraction limit',
      );
  }
  return archive;
}
export async function extractAssetText(
  filename: string,
  input: Buffer | Uint8Array,
  options: ExtractionOptions = {},
): Promise<{ text: string; method: string }> {
  const bytes = Buffer.from(input);
  const limit = Math.min(
    options.max_extracted_bytes ?? MAX_EXTRACTED_BYTES,
    MAX_EXTRACTED_BYTES,
  );
  if (
    limit <= 0 ||
    bytes.length >
      Math.min(options.max_asset_bytes ?? MAX_ASSET_BYTES, MAX_ASSET_BYTES)
  )
    throw new EcommerceError(
      'document_too_large',
      'Document exceeds the configured size limit',
    );
  const extension = path.extname(filename).toLowerCase();
  let text: string, method: string;
  if (
    ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json'].includes(extension)
  ) {
    text = decodeUtf8(bytes);
    method = 'utf8';
  } else if (extension === '.docx') {
    method = 'docx_xml';
    const archive = checkedArchive(bytes, limit);
    const document = archive.getEntry('word/document.xml');
    if (!document)
      throw new EcommerceError(
        'unsafe_document',
        'DOCX document.xml is missing',
      );
    let xml: Buffer;
    try {
      xml = document.getData();
    } catch {
      throw new EcommerceError('unsafe_document', 'Corrupt DOCX document');
    }
    if (xml.length > limit)
      throw new EcommerceError(
        'document_too_large',
        'DOCX XML exceeds the extraction limit',
      );
    text = xmlText(decodeUtf8(xml));
  } else if (extension === '.xlsx' && options.allow_binary_report) {
    const archive = checkedArchive(bytes, limit);
    if (!archive.getEntry('xl/workbook.xml'))
      throw new EcommerceError(
        'unsafe_document',
        'XLSX workbook.xml is missing',
      );
    // Structured report parsing belongs to reports.ts. The source bytes are preserved,
    // but no arbitrary binary text is fabricated or added to the knowledge index.
    return { text: '', method: 'binary_report' };
  } else if (extension === '.pdf') {
    method = 'pdftotext';
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new EcommerceError('unsafe_document', 'Invalid PDF header');
    if (options.pdf) text = await options.pdf(bytes);
    else {
      const temporary = await mkdtemp(
        path.join(os.tmpdir(), 'opendot-ecommerce-pdf-'),
      );
      try {
        const source = path.join(temporary, 'source.pdf');
        await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
        const result = await execute('pdftotext', ['-layout', source, '-'], {
          timeout: 15_000,
          maxBuffer: limit,
          windowsHide: true,
        });
        text = result.stdout;
      } catch (error) {
        throw new EcommerceError(
          'extraction_failed',
          'PDF text extraction failed or pdftotext is unavailable',
          { reason: (error as NodeJS.ErrnoException).code ?? 'parse_failed' },
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  } else
    throw new EcommerceError(
      'unsupported_format',
      `Unsupported document format: ${extension}`,
    );
  if (Buffer.byteLength(text, 'utf8') > limit)
    throw new EcommerceError(
      'document_too_large',
      'Extracted text exceeds the extraction limit; nothing was truncated',
    );
  if (!text.trim())
    throw new EcommerceError(
      'empty_extraction',
      'No readable text found; scanned documents need OCR or a text source',
    );
  return { text, method };
}

interface ParsedRow {
  row: number;
  value: Record<string, unknown>;
}
function csvRows(
  text: string,
  delimiter: string,
): {
  rows: ParsedRow[];
  errors: Array<{ row: number; code: string; message: string }>;
} {
  const records: Array<{ row: number; cells: string[] }> = [];
  const errors: Array<{ row: number; code: string; message: string }> = [];
  let row = 1,
    start = 1,
    cells: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === undefined) {
        errors.push({
          row: start,
          code: 'malformed_csv',
          message: 'Unclosed quoted field',
        });
        break;
      } else {
        cell += char;
        if (char === '\n') row++;
      }
      continue;
    }
    if (char === '"' && !cell && !closed) {
      quoted = true;
      continue;
    }
    if (
      closed &&
      char !== delimiter &&
      char !== '\n' &&
      char !== '\r' &&
      char !== undefined
    ) {
      errors.push({
        row: start,
        code: 'malformed_csv',
        message: 'Unexpected data after quoted field',
      });
      break;
    }
    if (char === delimiter) {
      cells.push(cell);
      cell = '';
      closed = false;
    } else if (char === '\n' || char === undefined) {
      cells.push(cell.replace(/\r$/, ''));
      if (cells.some((value) => value !== ''))
        records.push({ row: start, cells });
      cells = [];
      cell = '';
      closed = false;
      row++;
      start = row;
    } else if (!(closed && char === '\r')) cell += char;
  }
  const header = records.shift()?.cells.map((value) => value.trim()) ?? [];
  if (
    !header.length ||
    new Set(header).size !== header.length ||
    header.some(
      (value) =>
        !value || ['__proto__', 'constructor', 'prototype'].includes(value),
    )
  )
    throw new EcommerceError(
      'invalid_mapping',
      'CSV requires unique safe column names',
    );
  const rows: ParsedRow[] = [];
  for (const record of records) {
    if (record.cells.length !== header.length) {
      errors.push({
        row: record.row,
        code: 'invalid_columns',
        message: 'CSV field count does not match header',
      });
      continue;
    }
    rows.push({
      row: record.row,
      value: Object.fromEntries(
        header.map((key, index) => [key, record.cells[index]]),
      ),
    });
  }
  return { rows, errors };
}
function parseRows(
  filename: string,
  text: string,
): {
  rows: ParsedRow[];
  errors: Array<{ row: number; code: string; message: string }>;
} {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv' || ext === '.tsv')
    return csvRows(text, ext === '.tsv' ? '\t' : ',');
  if (ext !== '.json') return { rows: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EcommerceError('invalid_json', 'Invalid JSON document');
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed as { rows?: unknown })?.rows;
  if (!Array.isArray(rows))
    throw new EcommerceError(
      'invalid_mapping',
      'Specification JSON must be an array of rows or an object with rows',
    );
  return { rows: rows.map((value, i) => ({ row: i + 1, value })), errors: [] };
}
export async function importAssets(
  workspaceId: string,
  inputs: AssetInput[],
  mapping: ImportMapping,
  requestKey: string,
  options: ExtractionOptions = {},
): Promise<ImportBatchResult> {
  if (
    !workspaceId?.trim() ||
    !requestKey?.trim() ||
    requestKey.length > 128 ||
    !Array.isArray(inputs) ||
    !inputs.length ||
    inputs.length > 50
  )
    throw new EcommerceError(
      'invalid_request',
      'Workspace, bounded request key and 1–50 files are required',
    );
  const digest = sha256(
    canonicalJson({
      mapping,
      inputs: inputs.map((input) => ({
        filename: input.filename,
        metadata: input.metadata,
        hash: sha256(Buffer.from(input.bytes)),
      })),
    }),
  );
  const replay = getObject<{ digest: string; result: ImportBatchResult }>(
    workspaceId,
    'import',
    requestKey,
  );
  if (replay) {
    if (replay.body.digest !== digest)
      throw new EcommerceError(
        'idempotency_conflict',
        'Import key was already used with different content',
      );
    return { ...replay.body.result, replayed: true };
  }
  const pending: Array<{
    asset: SourceAsset;
    raw: Buffer;
    text: string;
    parsed: ReturnType<typeof parseRows>;
  }> = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    checkMetadata(workspaceId, input.metadata);
    if (
      !input.filename ||
      input.filename.length > 255 ||
      /[\\/\0]/.test(input.filename)
    )
      throw new EcommerceError(
        'invalid_request',
        'Filename must be a simple name',
      );
    const raw = Buffer.from(input.bytes);
    const extracted = await extractAssetText(input.filename, raw, {
      ...options,
      allow_binary_report: input.metadata.kind === 'report',
    });
    const contentHash = sha256(raw),
      metadata = input.metadata;
    const sourceId =
      metadata.source_id ??
      `asset_${sha256(`${workspaceId}:${requestKey}:${index}`).slice(0, 32)}`;
    const asset: SourceAsset = {
      ...metadata,
      workspace_id: workspaceId,
      source_id: sourceId,
      version: metadata.version ?? '1',
      known_at: timestamp(
        metadata.known_at ?? new Date().toISOString(),
        'known_at',
      ),
      observed_at: timestamp(metadata.observed_at, 'observed_at'),
      effective_from: metadata.effective_from
        ? timestamp(metadata.effective_from, 'effective_from')
        : null,
      effective_to: metadata.effective_to
        ? timestamp(metadata.effective_to, 'effective_to')
        : null,
      content_hash: contentHash,
      ingestion_status: 'ready',
      filename: input.filename,
      media_type:
        (
          {
            '.pdf': 'application/pdf',
            '.docx':
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xlsx':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.json': 'application/json',
            '.csv': 'text/csv',
          } as Record<string, string>
        )[path.extname(input.filename).toLowerCase()] ?? 'text/plain',
      byte_length: raw.length,
      source_url: metadata.source_url ?? null,
    };
    pending.push({
      asset,
      raw,
      text: extracted.text,
      parsed: ['product_fact', 'competitor'].includes(asset.kind)
        ? parseRows(input.filename, extracted.text)
        : { rows: [], errors: [] },
    });
  }
  return transact(() => {
    const raced = getObject<{ digest: string; result: ImportBatchResult }>(
      workspaceId,
      'import',
      requestKey,
    );
    if (raced) {
      if (raced.body.digest !== digest)
        throw new EcommerceError(
          'idempotency_conflict',
          'Import request changed',
        );
      return { ...raced.body.result, replayed: true };
    }
    const result: ImportBatchResult = {
      batch_id: `import_${sha256(`${workspaceId}:${requestKey}`).slice(0, 32)}`,
      assets: [],
      rows: [],
      row_errors: [],
      replayed: false,
    };
    for (const item of pending) {
      const asset = putSourceAsset(item.asset, item.raw, item.text);
      result.assets.push(asset);
      result.row_errors.push(
        ...item.parsed.errors.map((error) => ({
          ...error,
          source_id: asset.source_id,
        })),
      );
      for (const parsed of item.parsed.rows) {
        try {
          const data = parsed.value;
          if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new EcommerceError('invalid_row', 'Row must be an object');
          const sku = data[mapping.sku ?? 'sku'],
            field = data[mapping.field ?? 'field'];
          if (
            typeof sku !== 'string' ||
            !sku.trim() ||
            typeof field !== 'string' ||
            !field.trim()
          )
            throw new EcommerceError(
              'invalid_row',
              'SKU and field are required',
            );
          if (data.market !== undefined && data.market !== asset.market)
            throw new EcommerceError(
              'invalid_scope',
              'Row market does not match source',
            );
          if (
            asset.product_refs.length &&
            !asset.product_refs.some((ref) => ref.sku === sku)
          )
            throw new EcommerceError(
              'invalid_scope',
              'Row SKU does not match source references',
            );
          let value = data[mapping.value ?? 'value'];
          const valueType = mapping.value_type ?? data.value_type;
          if (
            valueType !== undefined &&
            !['number', 'boolean', 'string'].includes(valueType as string)
          )
            throw new EcommerceError(
              'invalid_value',
              'Unknown declared value type',
            );
          if (valueType === 'number') {
            if (value === '' || value === null || typeof value === 'boolean')
              throw new EcommerceError(
                'invalid_value',
                'A finite number is required',
              );
            value = Number(value);
          } else if (valueType === 'boolean') {
            if (value === 'true') value = true;
            else if (value === 'false') value = false;
            if (typeof value !== 'boolean')
              throw new EcommerceError(
                'invalid_value',
                'A boolean is required',
              );
          } else if (
            valueType === 'string' &&
            value !== null &&
            value !== undefined
          )
            value = String(value);
          if (
            (!['string', 'number', 'boolean'].includes(typeof value) &&
              value !== null) ||
            (typeof value === 'number' && !Number.isFinite(value))
          )
            throw new EcommerceError(
              'invalid_value',
              'Value must be a finite scalar or explicit null',
            );
          const unit = data[mapping.unit ?? 'unit'];
          if (unit !== undefined && unit !== null && typeof unit !== 'string')
            throw new EcommerceError('invalid_value', 'Unit must be text');
          const evidenceId = `ev_${sha256(`${asset.source_id}:${asset.version}:row:${parsed.row}`).slice(0, 32)}`;
          putEvidence(workspaceId, {
            evidence_id: evidenceId,
            source_id: asset.source_id,
            kind: asset.kind,
            locator: `version:${asset.version};row:${parsed.row}`,
            content_hash: asset.content_hash,
            provenance: asset.provenance,
            excerpt: canonicalJson(data),
          });
          const fact: ProductFact = {
            field,
            value: value as ProductFact['value'],
            unit: typeof unit === 'string' && unit.trim() ? unit : null,
            evidence_id: evidenceId,
            verification_state: 'candidate',
          };
          const candidate = {
            source_id: asset.source_id,
            row: parsed.row,
            sku,
            market: asset.market,
            fact,
          };
          if (!getObject(workspaceId, 'fact_candidate', evidenceId))
            putObject(workspaceId, 'fact_candidate', evidenceId, candidate, 0);
          result.rows.push(candidate);
        } catch (error) {
          if (!(error instanceof EcommerceError)) throw error;
          result.row_errors.push({
            source_id: asset.source_id,
            row: parsed.row,
            code: error.code,
            message: error.message,
          });
        }
      }
    }
    putObject(workspaceId, 'import', requestKey, { digest, result }, 0);
    return result;
  });
}
