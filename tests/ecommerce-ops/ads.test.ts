import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import {
  computeAdMetrics,
  parseMinorUnits,
} from '../../src/ecommerce-ops/metrics.js';
import {
  parseAdReport,
  validateReportScope,
  type ReportMetadata,
} from '../../src/ecommerce-ops/reports.js';

const metadata = (patch: Partial<ReportMetadata> = {}): ReportMetadata => ({
  report_id: 'report-1',
  workspace_id: 'web:demo',
  market: 'US',
  currency: 'USD',
  timezone: 'America/Los_Angeles',
  account: 'synthetic-account',
  ad_product: 'SP',
  advertiser_type: 'seller',
  attribution_window_days: 7,
  reporting_delay_days: 2,
  granularity: 'daily',
  date_range: { start: '2026-01-01', end: '2026-01-02' },
  generated_at: '2026-01-13T00:00:00Z',
  provenance: 'synthetic',
  ...patch,
});
const header =
  'Date,Campaign ID,Impressions,Clicks,Spend,Attributed Sales,Attributed Orders,Attributed Units';
function report(
  csv = `${header}\n2026-01-01,c1,1000,10,1.01,10.00,2,5\n2026-01-02,c1,100,2,0.02,0.00,0,0`,
  patch: Partial<ReportMetadata> = {},
) {
  const result = parseAdReport(csv, 'sp-campaign-v1', metadata(patch));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.report;
}
const scope = { ...metadata(), as_of: '2026-01-15T00:00:00Z' };

describe('ad metrics are deterministic and preserve report scope', () => {
  it('parses monetary decimal strings exactly without rounding or unsafe integers', () => {
    expect(parseMinorUnits('1.01')).toBe(101);
    expect(parseMinorUnits('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [
      '1.001',
      '-1',
      '1e3',
      'NaN',
      '90071992547409.92',
      '1,23',
    ])
      expect(() => parseMinorUnits(value)).toThrow();
  });
  it('sums numerators before ratios and uses orders rather than units for CVR', () => {
    const result = computeAdMetrics(report().rows, scope);
    expect(result.metrics).toMatchObject({
      currency: 'USD',
      spend_minor: 103,
      attributed_sales_minor: 1000,
      impressions: 1100,
      clicks: 12,
      attributed_orders: 2,
      acos_ratio: 0.103,
    });
    expect(result.metrics.roas).toBeCloseTo(1000 / 103, 6);
    expect(result.metrics.ctr_ratio).toBeCloseTo(12 / 1100, 6);
    expect(result.metrics.cpc_minor).toBeCloseTo(103 / 12, 6);
    expect(result.metrics.cvr_ratio).toBeCloseTo(2 / 12, 6);
    expect(result.maturity).toBe('complete');
    expect(result.evidence_refs).toHaveLength(2);
  });
  it('returns null and reasons for zero denominators', () => {
    const zero = report(`${header}\n2026-01-01,c1,0,0,0.00,0.00,0,4`);
    const result = computeAdMetrics(zero.rows, scope);
    expect([
      result.metrics.acos_ratio,
      result.metrics.roas,
      result.metrics.ctr_ratio,
      result.metrics.cpc_minor,
      result.metrics.cvr_ratio,
    ]).toEqual([null, null, null, null, null]);
    expect(Object.keys(result.null_reasons)).toHaveLength(5);
  });
  it('rejects unsafe integer sums and invalid direct callers', () => {
    const rows = report().rows;
    expect(() =>
      computeAdMetrics(
        [{ ...rows[0], impressions: Number.MAX_SAFE_INTEGER }, rows[1]],
        scope,
      ),
    ).toThrow();
    expect(() =>
      computeAdMetrics([{ ...rows[0], spend_minor: -1 }], scope),
    ).toThrow();
  });
  it('uses the report timezone, attribution window and reporting delay for maturity', () => {
    const rows = report().rows;
    expect(
      computeAdMetrics(rows, {
        ...scope,
        generated_at: '2026-01-12T08:00:00Z',
        as_of: '2026-01-12T08:00:00Z',
      }).maturity,
    ).toBe('complete');
    expect(
      computeAdMetrics(rows, {
        ...scope,
        generated_at: '2026-01-12T07:00:00Z',
        as_of: '2026-01-12T07:00:00Z',
      }).maturity,
    ).toBe('incomplete');
    expect(
      computeAdMetrics(rows, { ...scope, generated_at: '2026-01-03T00:00:00Z' })
        .maturity,
    ).toBe('incomplete');
    const unknown = computeAdMetrics(rows, {
      ...scope,
      attribution_window_days: null,
    });
    expect(unknown.maturity).toBe('unknown');
    expect(unknown.allow_negative_targeting).toBe(false);
  });
  it.each([
    'currency',
    'timezone',
    'account',
    'advertiser_type',
    'attribution_window_days',
    'granularity',
  ] as const)('blocks mixed %s', (field) => {
    const patch = {
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      account: 'other',
      advertiser_type: 'vendor',
      attribution_window_days: 14,
      granularity: 'summary',
    };
    const second = {
      ...report(),
      metadata: {
        ...metadata({ report_id: 'report-2' }),
        [field]: patch[field],
      },
    };
    expect(validateReportScope([report(), second]).ok).toBe(false);
  });
  it('deduplicates exact rows but blocks conflicting values of the same dimensional row', () => {
    const one = report();
    const exact = {
      ...one,
      metadata: { ...one.metadata, report_id: 'report-2' },
    };
    const result = validateReportScope([one, exact]);
    expect(result.ok && result.rows).toHaveLength(2);
    const conflict = {
      ...exact,
      rows: exact.rows.map((r, i) => (i ? r : { ...r, clicks: 11 })),
    };
    expect(validateReportScope([one, conflict]).ok).toBe(false);
  });
  it('rejects mixed campaign/search-term grain and overlapping non-splittable summaries', () => {
    const one = report();
    expect(
      validateReportScope([one, { ...one, mapping: 'sp-search-term-v1' }]).ok,
    ).toBe(false);
    const summary = {
      ...one,
      metadata: { ...one.metadata, granularity: 'summary' as const },
    };
    expect(
      validateReportScope([
        summary,
        { ...summary, metadata: { ...summary.metadata, report_id: 's2' } },
      ]).ok,
    ).toBe(false);
  });
  it('allows only equal-length mature nonoverlapping comparison windows and discloses no causality', () => {
    const prior = report(`${header}\n2025-12-01,c1,100,2,1.00,2.00,1,1`, {
      report_id: 'previous',
      date_range: { start: '2025-12-01', end: '2025-12-02' },
    });
    const good = validateReportScope([prior, report()], {
      mode: 'compare',
      asOf: scope.as_of,
    });
    expect(good.ok).toBe(true);
    expect(good.comparison?.disclaimer).toMatch(/因果/);
    expect(
      validateReportScope([prior, report()], {
        mode: 'compare',
        asOf: '2026-01-04T00:00:00Z',
      }).ok,
    ).toBe(false);
    expect(
      validateReportScope(
        [
          prior,
          report(`${header}\n2026-01-01,c1,100,2,1.00,2.00,1,1`, {
            date_range: { start: '2026-01-01', end: '2026-01-03' },
          }),
        ],
        { mode: 'compare', asOf: scope.as_of },
      ).ok,
    ).toBe(false);
  });
});

describe('fixed mapping report imports', () => {
  it('accepts both delivered synthetic CSV and XLSX templates with the same metrics', () => {
    for (const stem of ['sp-campaign', 'sp-search-term'] as const) {
      const base = `docs/ecommerce-ops/templates/${stem}`;
      const meta = JSON.parse(fs.readFileSync(`${base}.metadata.json`, 'utf8'));
      const csv = parseAdReport(
        fs.readFileSync(`${base}.csv`),
        `${stem}-v1`,
        meta,
      );
      const xlsx = parseAdReport(
        fs.readFileSync(`${base}.xlsx`),
        `${stem}-v1`,
        meta,
        'xlsx',
      );
      expect(csv.ok).toBe(true);
      expect(xlsx.ok).toBe(true);
      if (csv.ok && xlsx.ok)
        expect(
          computeAdMetrics(csv.report.rows, { ...meta, as_of: scope.as_of })
            .metrics,
        ).toEqual(
          computeAdMetrics(xlsx.report.rows, { ...meta, as_of: scope.as_of })
            .metrics,
        );
    }
  });
  it('keeps sparse XLSX row anchors and rejects formulas without cached text', () => {
    const zip = new AdmZip();
    const headings = header
      .split(',')
      .map(
        (v, i) =>
          `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${v}</t></is></c>`,
      )
      .join('');
    const cells = ['2026-01-01', 'c1', '100', '2', '1.00', '2.00', '1', '1']
      .map(
        (v, i) =>
          `<c r="${String.fromCharCode(65 + i)}3" t="inlineStr"><is><t>${v}</t></is></c>`,
      )
      .join('');
    zip.addFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        `<worksheet><sheetData><row r="1">${headings}</row><row r="3">${cells}</row></sheetData></worksheet>`,
      ),
    );
    const result = parseAdReport(
      zip.toBuffer(),
      'sp-campaign-v1',
      metadata(),
      'xlsx',
    );
    expect(result.ok && result.report.rows[0].source_row).toBe(3);
    zip.updateFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        `<worksheet><sheetData><row r="1">${headings}</row><row r="2"><c r="A2"><f/><v>0</v></c></row></sheetData></worksheet>`,
      ),
    );
    const poison = parseAdReport(
      zip.toBuffer(),
      'sp-campaign-v1',
      metadata(),
      'xlsx',
    );
    expect(!poison.ok && poison.errors[0].code).toBe('REPORT_PARSE');
  });
  it('supports quoted CSV fields and keeps distinct search-term dimensional rows', () => {
    const csv =
      'Date,Campaign ID,Ad Group ID,Search Term,Targeting,Match Type,Impressions,Clicks,Spend,Attributed Sales,Attributed Orders,Attributed Units\n2026-01-01,c1,g1,"travel, kettle",kettle,exact,100,2,0.20,2.00,1,1\n2026-01-01,c1,g1,"travel, kettle",travel,broad,100,2,0.20,2.00,1,1';
    const parsed = parseAdReport(csv, 'sp-search-term-v1', metadata());
    expect(parsed.ok && parsed.report.rows).toHaveLength(2);
    if (parsed.ok)
      expect(parsed.report.rows[0].dedupe_key).not.toBe(
        parsed.report.rows[1].dedupe_key,
      );
  });
  it('reports row errors and requires an explicitly supported mapping and complete metadata', () => {
    const bad = parseAdReport(
      `${header}\n2026-01-01,c1,100,1.5,0.001,2,1,1`,
      'sp-campaign-v1',
      metadata(),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.errors.some((e) => e.row === 2 && e.field === 'clicks')).toBe(
        true,
      );
    expect(parseAdReport(header, 'guessed' as any, metadata()).ok).toBe(false);
    expect(
      parseAdReport(header, 'sp-campaign-v1', { ...metadata(), account: '' })
        .ok,
    ).toBe(false);
  });
  it('preserves CSV row locators around blank records and rejects conflicting rows rather than silently discarding them', () => {
    const parsed = parseAdReport(
      `${header}\n\n2026-01-01,c1,100,2,1.00,2.00,1,1`,
      'sp-campaign-v1',
      metadata(),
    );
    expect(parsed.ok && parsed.report.rows[0].source_row).toBe(3);
    const duplicate = report(
      `${header}\n2026-01-01,c1,100,2,1.00,2.00,1,1\n2026-01-01,c1,100,3,1.00,2.00,1,1`,
    );
    expect(validateReportScope([duplicate]).ok).toBe(false);
  });
  it('reads a bounded values-only XLSX and rejects formulas or external XML content', () => {
    const workbook = (formula = '') => {
      const zip = new AdmZip();
      const headers = header
        .split(',')
        .map(
          (value, i) =>
            `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${value}</t></is></c>`,
        )
        .join('');
      const values = ['2026-01-01', 'c1', '100', '2', '1.01', '2.00', '1', '1']
        .map(
          (v, i) =>
            `<c r="${String.fromCharCode(65 + i)}2" t="inlineStr">${formula && i === 4 ? `<f>${formula}</f>` : ''}<is><t>${v}</t></is></c>`,
        )
        .join('');
      zip.addFile(
        'xl/worksheets/sheet1.xml',
        Buffer.from(
          `<worksheet><sheetData><row r="1">${headers}</row><row r="2">${values}</row></sheetData></worksheet>`,
        ),
      );
      return zip.toBuffer();
    };
    const parsed = parseAdReport(
      workbook(),
      'sp-campaign-v1',
      metadata(),
      'xlsx',
    );
    expect(parsed.ok && parsed.report.rows[0].spend_minor).toBe(101);
    expect(
      parseAdReport(workbook('1+1'), 'sp-campaign-v1', metadata(), 'xlsx').ok,
    ).toBe(false);
  });
});
