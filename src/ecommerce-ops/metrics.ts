import type { AdReportRow, ReportMetadata } from './reports.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** The fixed import templates use a dot decimal and USD/EUR minor units. */
export function parseMinorUnits(value: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw new Error(
      'Money must be a nonnegative decimal with at most two decimal places',
    );
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > MAX_SAFE)
    throw new Error('Money exceeds safe integer minor units');
  return Number(minor);
}

export interface AdMetrics {
  currency: 'USD' | 'EUR';
  spend_minor: number;
  attributed_sales_minor: number;
  impressions: number;
  clicks: number;
  attributed_orders: number;
  acos_ratio: number | null;
  roas: number | null;
  ctr_ratio: number | null;
  cpc_minor: number | null;
  cvr_ratio: number | null;
}

export type MetricScope = ReportMetadata & { as_of: string };
export type AttributionMaturity = 'complete' | 'incomplete' | 'unknown';

function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('Invalid report date');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new Error('Invalid report date');
  return time / 86_400_000;
}

/** A date includes its whole reporting day. DST is handled by the IANA local date. */
export function attributionMaturity(scope: MetricScope): AttributionMaturity {
  const window = scope.attribution_window_days,
    delay = scope.reporting_delay_days;
  if (
    window === null ||
    delay === null ||
    !Number.isSafeInteger(window) ||
    !Number.isSafeInteger(delay) ||
    window < 0 ||
    delay < 0
  )
    return 'unknown';
  const asOf = Date.parse(scope.as_of),
    generated = Date.parse(scope.generated_at);
  if (!Number.isFinite(asOf) || !Number.isFinite(generated) || generated > asOf)
    return 'unknown';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: scope.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(Math.min(asOf, generated)));
    const part = (kind: string) => parts.find((p) => p.type === kind)?.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    return dateNumber(day) >=
      dateNumber(scope.date_range.end) + 1 + window + delay
      ? 'complete'
      : 'incomplete';
  } catch {
    return 'unknown';
  }
}

/** Integer decimal division; formatting as a percent belongs to the view. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const scale = 1_000_000_000_000n;
  const rounded =
    (BigInt(numerator) * scale + BigInt(denominator) / 2n) /
    BigInt(denominator);
  return Number(rounded) / Number(scale);
}

export function computeAdMetrics(
  rows: readonly AdReportRow[],
  scope: MetricScope,
) {
  if (!rows.length) throw new Error('At least one report row is required');
  if (
    (scope.market === 'US' && scope.currency !== 'USD') ||
    (scope.market === 'DE' && scope.currency !== 'EUR')
  )
    throw new Error('Market currency mismatch');
  const keys = [
    'spend_minor',
    'attributed_sales_minor',
    'impressions',
    'clicks',
    'attributed_orders',
  ] as const;
  const totals = {
    spend_minor: 0,
    attributed_sales_minor: 0,
    impressions: 0,
    clicks: 0,
    attributed_orders: 0,
  };
  const seen = new Map<string, string>(),
    evidence = new Set<string>();
  let rowCount = 0;
  for (const row of rows) {
    for (const key of [...keys, 'attributed_units'] as const) {
      const value = row[key];
      if (key === 'attributed_units' && value === null) continue;
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw new Error(`Invalid nonnegative safe integer: ${key}`);
    }
    if (
      scope.granularity === 'daily' &&
      (!row.date ||
        row.date < scope.date_range.start ||
        row.date > scope.date_range.end)
    )
      throw new Error('Report row date is outside the frozen scope');
    const values = JSON.stringify([
      ...keys.map((key) => row[key]),
      row.attributed_units,
    ]);
    const previous = seen.get(row.dedupe_key);
    if (previous !== undefined && previous !== values)
      throw new Error('Conflicting report row');
    evidence.add(row.evidence_id);
    if (previous !== undefined) continue;
    seen.set(row.dedupe_key, values);
    rowCount++;
    for (const key of keys) {
      const sum = BigInt(totals[key]) + BigInt(row[key]);
      if (sum > MAX_SAFE) throw new Error(`Unsafe integer aggregate: ${key}`);
      totals[key] = Number(sum);
    }
  }
  const metrics: AdMetrics = {
    currency: scope.currency,
    ...totals,
    acos_ratio: ratio(totals.spend_minor, totals.attributed_sales_minor),
    roas: ratio(totals.attributed_sales_minor, totals.spend_minor),
    ctr_ratio: ratio(totals.clicks, totals.impressions),
    cpc_minor: ratio(totals.spend_minor, totals.clicks),
    cvr_ratio: ratio(totals.attributed_orders, totals.clicks),
  };
  const null_reasons: Record<string, string> = {};
  const denominators = {
    acos_ratio: 'attributed_sales_minor',
    roas: 'spend_minor',
    ctr_ratio: 'impressions',
    cpc_minor: 'clicks',
    cvr_ratio: 'clicks',
  };
  for (const [key, denominator] of Object.entries(denominators))
    if (metrics[key as keyof AdMetrics] === null)
      null_reasons[key] = `${denominator}=0; ratio is undefined`;
  const maturity = attributionMaturity(scope);
  return {
    metrics,
    null_reasons,
    maturity,
    row_count: rowCount,
    evidence_refs: [...evidence],
    allow_negative_targeting: false as const,
    units: { ratios: 'ratio', money: 'minor_unit', cpc_minor: 'minor_unit' },
    limitations: [
      '仅描述导入报表；广告归因销售不是额外营收，不能相减推算精确自然销售。',
      '没有匹配口径的业务总销售，不计算TACoS；所有投放动作需要人工判断。',
      ...(maturity === 'complete'
        ? []
        : ['归因未成熟或窗口未知，不据近期零转化建议否词或停投。']),
    ],
  };
}
