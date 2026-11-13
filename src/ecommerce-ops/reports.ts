import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { attributionMaturity, parseMinorUnits } from './metrics.js';

export type ReportMapping = 'sp-search-term-v1' | 'sp-campaign-v1';
export interface ReportMetadata {
  report_id: string;
  workspace_id: string;
  market: 'US' | 'DE';
  currency: 'USD' | 'EUR';
  timezone: string;
  account: string;
  ad_product: 'SP';
  advertiser_type: 'seller' | 'vendor';
  attribution_window_days: number | null;
  reporting_delay_days: number | null;
  granularity: 'daily' | 'summary';
  date_range: { start: string; end: string };
  generated_at: string;
  provenance: 'real' | 'redacted' | 'synthetic' | 'public';
}
export interface AdReportRow {
  report_id: string;
  source_row: number;
  evidence_id: string;
  dedupe_key: string;
  date: string | null;
  campaign_id: string;
  ad_group_id: string | null;
  search_term: string | null;
  targeting: string | null;
  match_type: string | null;
  impressions: number;
  clicks: number;
  spend_minor: number;
  attributed_sales_minor: number;
  attributed_orders: number;
  attributed_units: number | null;
}
export interface NormalizedAdReport {
  metadata: ReportMetadata;
  mapping: ReportMapping;
  source: 'import';
  content_hash: string;
  rows: AdReportRow[];
}
export interface ReportError {
  row: number;
  field: string;
  code: string;
  message: string;
}
const campaignHeaders = [
  'Date',
  'Campaign ID',
  'Impressions',
  'Clicks',
  'Spend',
  'Attributed Sales',
  'Attributed Orders',
  'Attributed Units',
];
const searchHeaders = [
  'Date',
  'Campaign ID',
  'Ad Group ID',
  'Search Term',
  'Targeting',
  'Match Type',
  'Impressions',
  'Clicks',
  'Spend',
  'Attributed Sales',
  'Attributed Orders',
  'Attributed Units',
];
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const validDate = (date: unknown): date is string =>
  typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function validateReportMetadata(raw: unknown): ReportError[] {
  const errors: ReportError[] = [],
    value = raw as Partial<ReportMetadata> | null;
  const error = (field: string, message: string) =>
    errors.push({ row: 0, field, code: 'REPORT_METADATA', message });
  if (!value || typeof value !== 'object') {
    error('metadata', 'Required metadata object');
    return errors;
  }
  for (const key of [
    'report_id',
    'workspace_id',
    'account',
    'timezone',
  ] as const)
    if (typeof value[key] !== 'string' || !value[key]?.trim())
      error(key, `${key} is required`);
  if (!['US', 'DE'].includes(value.market ?? ''))
    error('market', 'Supported markets: US, DE');
  if (
    !['USD', 'EUR'].includes(value.currency ?? '') ||
    (value.market === 'US' && value.currency !== 'USD') ||
    (value.market === 'DE' && value.currency !== 'EUR')
  )
    error('currency', 'Currency must match market');
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
  } catch {
    error('timezone', 'Valid IANA report timezone required');
  }
  if (value.ad_product !== 'SP')
    error('ad_product', 'Only Sponsored Products is supported');
  if (!['seller', 'vendor'].includes(value.advertiser_type ?? ''))
    error('advertiser_type', 'seller or vendor is required');
  for (const field of [
    'attribution_window_days',
    'reporting_delay_days',
  ] as const)
    if (
      value[field] !== null &&
      (!Number.isSafeInteger(value[field]) ||
        (value[field] as number) < 0 ||
        (value[field] as number) > 365)
    )
      error(field, `${field} must be known nonnegative days or explicit null`);
  if (!['daily', 'summary'].includes(value.granularity ?? ''))
    error('granularity', 'daily or summary required');
  if (
    !validDate(value.date_range?.start) ||
    !validDate(value.date_range?.end) ||
    value.date_range!.start > value.date_range!.end
  )
    error('date_range', 'Valid inclusive date range required');
  if (!instant(value.generated_at))
    error('generated_at', 'Offset-bearing generated_at required');
  if (
    !['real', 'redacted', 'synthetic', 'public'].includes(
      value.provenance ?? '',
    )
  )
    error('provenance', 'Explicit data provenance required');
  return errors;
}

function csvRows(text: string): string[][] {
  if (text.length > 5 * 1024 * 1024 || text.includes('\0'))
    throw new Error('CSV size or encoding unsupported');
  const rows: string[][] = [],
    row: string[] = [];
  let field = '',
    quoted = false,
    closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error('Invalid CSV quoting');
      quoted = true;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (char !== ',') {
        rows.push([...row]);
        row.length = 0;
        if (char === '\r' && text[index + 1] === '\n') index++;
      }
    } else {
      if (closed) throw new Error('Unexpected content after quoted CSV field');
      field += char;
    }
    if (rows.length > 100_000 || field.length > 32_768)
      throw new Error('CSV row or field limit exceeded');
  }
  if (quoted) throw new Error('Unclosed CSV quoted field');
  if (field || row.length || closed) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function decodeXml(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(text))
    throw new Error('Unsupported XML entity');
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      if (entity[0] !== '#') return named[entity.toLowerCase()];
      const code =
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new Error('Invalid XML character');
      return String.fromCodePoint(code);
    },
  );
}
function xmlTexts(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((m) => decodeXml(m[1]))
    .join('');
}
function xlsxRows(bytes: Buffer): string[][] {
  if (bytes.length > 5 * 1024 * 1024)
    throw new Error('XLSX size limit exceeded');
  const zip = new AdmZip(bytes),
    entries = zip.getEntries();
  if (entries.length > 128) throw new Error('XLSX entry limit exceeded');
  let total = 0;
  const xml = new Map<string, string>();
  for (const entry of entries) {
    const name = entry.entryName;
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      /(?:vbaProject|externalLinks|embeddings|connections)/i.test(name)
    )
      throw new Error('Unsupported or unsafe XLSX entry');
    total += entry.header.size;
    if (entry.header.size > 5 * 1024 * 1024 || total > 10 * 1024 * 1024)
      throw new Error('Expanded XLSX size limit exceeded');
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const data = entry.getData();
    if (data.length !== entry.header.size)
      throw new Error('Invalid XLSX entry size');
    const text = data.toString('utf8');
    if (
      /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External|<(?:\w+:)?f(?:\s|\/?>)/i.test(
        text,
      )
    )
      throw new Error('XLSX formulas and external XML are unsupported');
    if (xml.has(name)) throw new Error('Duplicate XLSX entry');
    xml.set(name, text);
  }
  const worksheets = [...xml].filter(([name]) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  if (worksheets.length !== 1)
    throw new Error('XLSX must have exactly one values-only worksheet');
  const strings = [
    ...(xml.get('xl/sharedStrings.xml') ?? '').matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g,
    ),
  ].map((m) => xmlTexts(m[1]));
  const rows: string[][] = [];
  for (const row of worksheets[0][1].matchAll(
    /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g,
  )) {
    const position = Number(/\br=["'](\d+)["']/.exec(row[1])?.[1]);
    if (
      !Number.isSafeInteger(position) ||
      position <= rows.length ||
      position > 100_000
    )
      throw new Error('Invalid or duplicate XLSX row anchor');
    while (rows.length < position - 1) rows.push([]);
    const values: string[] = [];
    for (const cell of row[2].matchAll(
      /<(?:\w+:)?c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g,
    )) {
      const ref = /\br=["']([A-Z]+)(\d+)["']/.exec(cell[1]);
      if (!ref || Number(ref[2]) !== position)
        throw new Error('Matching XLSX cell reference required');
      const column =
        [...ref[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      if (column > 100 || values[column] !== undefined)
        throw new Error('Invalid XLSX column');
      const type = /\bt=["']([^"']+)["']/.exec(cell[1])?.[1],
        content = cell[2] ?? '';
      const raw =
        /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(content)?.[1] ??
        '';
      if (type === 's') {
        if (!/^\d+$/.test(raw) || strings[Number(raw)] === undefined)
          throw new Error('Invalid XLSX shared string');
        values[column] = strings[Number(raw)];
      } else if (type === 'inlineStr') values[column] = xmlTexts(content);
      else if (!type || type === 'n' || type === 'str')
        values[column] = decodeXml(raw);
      else throw new Error('Unsupported XLSX cell type');
    }
    rows.push(Array.from({ length: values.length }, (_, i) => values[i] ?? ''));
    if (rows.length > 100_000) throw new Error('XLSX row limit exceeded');
  }
  return rows;
}

export function parseAdReport(
  input: Buffer | string,
  mapping: ReportMapping,
  rawMetadata: unknown,
  format: 'csv' | 'xlsx' = 'csv',
):
  | { ok: true; report: NormalizedAdReport }
  | { ok: false; errors: ReportError[] } {
  const errors = validateReportMetadata(rawMetadata);
  if (mapping !== 'sp-search-term-v1' && mapping !== 'sp-campaign-v1')
    errors.push({
      row: 1,
      field: 'mapping',
      code: 'MAPPING_REQUIRED',
      message:
        'Select one of the two verified fixed mappings; automatic field guessing is disabled',
    });
  if (errors.length) return { ok: false, errors };
  const metadata = structuredClone(rawMetadata as ReportMetadata),
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let table: string[][];
  try {
    if (format !== 'csv' && format !== 'xlsx')
      throw new Error('Unsupported report format');
    table =
      format === 'xlsx'
        ? xlsxRows(bytes)
        : csvRows(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          row: 0,
          field: 'file',
          code: 'REPORT_PARSE',
          message: (error as Error).message,
        },
      ],
    };
  }
  const headers =
    mapping === 'sp-campaign-v1' ? campaignHeaders : searchHeaders;
  if (
    JSON.stringify(table[0]?.map((s) => s.trim())) !== JSON.stringify(headers)
  )
    return {
      ok: false,
      errors: [
        {
          row: 1,
          field: 'headers',
          code: 'MAPPING_MISMATCH',
          message: `Expected fixed headers: ${headers.join(',')}`,
        },
      ],
    };
  if (table.length < 2)
    return {
      ok: false,
      errors: [
        {
          row: 2,
          field: 'rows',
          code: 'REPORT_EMPTY',
          message: 'Report has no data rows',
        },
      ],
    };
  const rows: AdReportRow[] = [];
  table.slice(1).forEach((cells, index) => {
    const source_row = index + 2,
      before = errors.length;
    const fail = (field: string, message: string) =>
      errors.push({ row: source_row, field, code: 'REPORT_ROW', message });
    if (cells.every((cell) => !cell.trim())) return;
    if (cells.length !== headers.length) {
      fail('columns', 'Row column count differs from fixed mapping');
      return;
    }
    const get = (name: string) => cells[headers.indexOf(name)]?.trim() ?? '';
    const integer = (name: string, field: string) => {
      const text = get(name);
      if (
        !/^\d+$/.test(text) ||
        BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        fail(field, 'Nonnegative safe integer required');
        return 0;
      }
      return Number(text);
    };
    const money = (name: string, field: string) => {
      try {
        return parseMinorUnits(get(name));
      } catch (error) {
        fail(field, (error as Error).message);
        return 0;
      }
    };
    const date = get('Date') || null,
      campaign_id = get('Campaign ID');
    if (
      metadata.granularity === 'daily' &&
      (!validDate(date) ||
        date < metadata.date_range.start ||
        date > metadata.date_range.end)
    )
      fail('date', 'Daily row date must be within the declared range');
    if (metadata.granularity === 'summary' && date !== null)
      fail(
        'date',
        'Summary rows require an empty date; date range is metadata',
      );
    if (!campaign_id) fail('campaign_id', 'Campaign ID required');
    const ad_group_id = get('Ad Group ID') || null,
      search_term = get('Search Term') || null,
      targeting = get('Targeting') || null,
      match_type = get('Match Type') || null;
    if (
      mapping === 'sp-search-term-v1' &&
      (!ad_group_id || !search_term || !targeting || !match_type)
    )
      fail(
        'dimensions',
        'Search term rows require ad group, search term, targeting and match type',
      );
    const row: AdReportRow = {
      report_id: metadata.report_id,
      source_row,
      evidence_id: `${metadata.report_id}:row:${source_row}`,
      dedupe_key: hash(
        JSON.stringify([
          metadata.workspace_id,
          metadata.account,
          metadata.market,
          metadata.currency,
          metadata.timezone,
          metadata.ad_product,
          metadata.advertiser_type,
          metadata.attribution_window_days,
          metadata.granularity,
          mapping,
          date ?? metadata.date_range,
          campaign_id,
          ad_group_id,
          search_term,
          targeting,
          match_type,
        ]),
      ),
      date,
      campaign_id,
      ad_group_id,
      search_term,
      targeting,
      match_type,
      impressions: integer('Impressions', 'impressions'),
      clicks: integer('Clicks', 'clicks'),
      spend_minor: money('Spend', 'spend_minor'),
      attributed_sales_minor: money(
        'Attributed Sales',
        'attributed_sales_minor',
      ),
      attributed_orders: integer('Attributed Orders', 'attributed_orders'),
      attributed_units:
        get('Attributed Units') === ''
          ? null
          : integer('Attributed Units', 'attributed_units'),
    };
    if (errors.length === before) rows.push(row);
  });
  if (errors.length) return { ok: false, errors };
  if (!rows.length)
    return {
      ok: false,
      errors: [
        {
          row: 2,
          field: 'rows',
          code: 'REPORT_EMPTY',
          message: 'Report has no data rows',
        },
      ],
    };
  return {
    ok: true,
    report: {
      metadata,
      mapping,
      source: 'import',
      content_hash: hash(bytes),
      rows,
    },
  };
}

export function validateReportScope(
  reports: readonly NormalizedAdReport[],
  options: { mode?: 'aggregate' | 'compare'; asOf?: string } = {},
): {
  ok: boolean;
  reasons: ReportError[];
  rows?: AdReportRow[];
  scope?: ReportMetadata;
  comparison?: { report_ids: string[]; disclaimer: string };
} {
  const reasons: ReportError[] = [];
  const fail = (field: string, code: string, message: string) =>
    reasons.push({ row: 0, field, code, message });
  if (!reports.length)
    return {
      ok: false,
      reasons: [
        {
          row: 0,
          field: 'reports',
          code: 'REPORT_EMPTY',
          message: 'At least one report is required',
        },
      ],
    };
  const first = reports[0];
  for (const report of reports) {
    reasons.push(...validateReportMetadata(report.metadata));
    for (const key of [
      'workspace_id',
      'market',
      'currency',
      'timezone',
      'account',
      'ad_product',
      'advertiser_type',
      'attribution_window_days',
      'reporting_delay_days',
      'granularity',
    ] as const)
      if (report.metadata[key] !== first.metadata[key])
        fail(key, 'INCOMPARABLE_SCOPE', `Mixed ${key} cannot be combined`);
    if (report.mapping !== first.mapping)
      fail(
        'mapping',
        'MIXED_GRAIN',
        'Campaign and search-term reports cannot be stacked',
      );
  }
  if (reasons.length) return { ok: false, reasons };
  if (options.mode === 'compare') {
    if (reports.length !== 2 || !options.asOf)
      fail(
        'comparison',
        'COMPARISON_SCOPE',
        'Comparison requires exactly two reports and an as-of timestamp',
      );
    const length = (m: ReportMetadata) =>
      Date.parse(m.date_range.end) - Date.parse(m.date_range.start);
    if (reports.some((r) => length(r.metadata) !== length(first.metadata)))
      fail(
        'date_range',
        'UNEQUAL_WINDOWS',
        'Comparison windows must be equal length',
      );
    if (
      reports.length === 2 &&
      reports[0].metadata.date_range.start <=
        reports[1].metadata.date_range.end &&
      reports[1].metadata.date_range.start <= reports[0].metadata.date_range.end
    )
      fail(
        'date_range',
        'OVERLAPPING_WINDOWS',
        'Comparison windows must not overlap',
      );
    if (
      reports.some(
        (r) =>
          attributionMaturity({ ...r.metadata, as_of: options.asOf ?? '' }) !==
          'complete',
      )
    )
      fail(
        'maturity',
        'IMMATURE_COMPARISON',
        'Only fully mature attribution windows are comparable',
      );
    return {
      ok: !reasons.length,
      reasons,
      ...(reasons.length
        ? {}
        : {
            comparison: {
              report_ids: reports.map((r) => r.metadata.report_id),
              disclaimer:
                '环比仅为描述性比较，不代表因果；需核实季节、促销、库存及活动差异。',
            },
          }),
    };
  }
  for (let i = 0; i < reports.length; i++)
    for (let j = i + 1; j < reports.length; j++) {
      if (
        first.metadata.granularity === 'summary' &&
        reports[i].metadata.date_range.start <=
          reports[j].metadata.date_range.end &&
        reports[j].metadata.date_range.start <=
          reports[i].metadata.date_range.end
      )
        fail(
          'date_range',
          'OVERLAPPING_SUMMARY',
          'Overlapping period summaries cannot be split or deduplicated safely',
        );
    }
  const unique = new Map<string, AdReportRow>();
  for (const report of reports)
    for (const row of report.rows) {
      const previous = unique.get(row.dedupe_key);
      const values = (r: AdReportRow) =>
        JSON.stringify([
          r.date,
          r.campaign_id,
          r.ad_group_id,
          r.search_term,
          r.targeting,
          r.match_type,
          r.impressions,
          r.clicks,
          r.spend_minor,
          r.attributed_sales_minor,
          r.attributed_orders,
          r.attributed_units,
        ]);
      if (previous && values(previous) !== values(row))
        fail(
          'rows',
          'ROW_CONFLICT',
          `Conflicting dimensional row ${row.evidence_id}`,
        );
      else if (!previous) unique.set(row.dedupe_key, row);
    }
  const dates = reports.map((r) => r.metadata.date_range);
  const scope = {
    ...first.metadata,
    date_range: {
      start: dates.map((d) => d.start).sort()[0],
      end: dates
        .map((d) => d.end)
        .sort()
        .at(-1)!,
    },
  };
  return {
    ok: !reasons.length,
    reasons,
    ...(reasons.length ? {} : { rows: [...unique.values()], scope }),
  };
}
