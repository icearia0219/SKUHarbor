import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Label } from '@/components/ui/label';
import { withBasePath } from '../../utils/url';
import {
  asRecord,
  asRecords,
  textValue,
  type EcomRecord,
} from '../../stores/ecommerce-ops';

export const selectClass =
  'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const assetId = (asset: EcomRecord) =>
  textValue(asset.id ?? asset.source_id);
export const reportId = (report: EcomRecord) =>
  textValue(report.id ?? asRecord(report.metadata).report_id);
export async function downloadSource(path: string, filename: string) {
  const response = await fetch(withBasePath(path), { credentials: 'include' });
  if (!response.ok)
    throw new Error(`原文读取失败（${response.status}），请刷新授权后重试`);
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export type RunAction = (
  work: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children) ? children : null;
  const id = child?.props.id ?? generatedId;
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      {child
        ? cloneElement(child as ReactElement<{ id?: string }>, { id })
        : children}
    </div>
  );
}
export function useRequestKey() {
  const last = useRef({ payload: '', key: '' });
  const keyFor = (payload: unknown) => {
    const serialized = JSON.stringify(payload);
    if (serialized !== last.current.payload)
      last.current = { payload: serialized, key: crypto.randomUUID() };
    return last.current.key;
  };
  keyFor.reset = () => {
    last.current = { payload: '', key: '' };
  };
  return keyFor;
}
export function DetailValue({ value }: { value: unknown }) {
  if (value == null)
    return <span className="text-muted-foreground">未知 / 未提供</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ul className="space-y-2">
        {value.map((item, index) => (
          <li className="border-l border-border pl-3" key={index}>
            <DetailValue value={item} />
          </li>
        ))}
      </ul>
    ) : (
      <span className="text-muted-foreground">暂无</span>
    );
  if (typeof value === 'object')
    return (
      <dl className="space-y-3">
        {Object.entries(asRecord(value)).map(([key, item]) => (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">
              {fieldLabels[key] ?? key}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words">
              <DetailValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span className="whitespace-pre-wrap break-words">{textValue(value)}</span>
  );
}
export const fieldLabels: Record<string, string> = {
  title: '标题',
  bullets: '卖点',
  description: '描述',
  search_terms: '搜索词',
  copies: '文案方案',
  reply: '客服回复',
  numerator: '分子',
  denominator: '分母',
  value: '值',
  unit: '单位',
  currency: '币种',
  metrics: '指标快照',
  date_range: '报告窗口',
  attribution_window_days: '归因窗口（天）',
  maturity: '归因成熟度',
  source_rows: '来源行',
  recommendations: '建议',
  evidence_ids: '证据引用',
  issues: '未检查项与问题',
  unchecked: '未检查项',
  reason: '理由',
  message: '说明',
  code: '类型',
  field: '字段',
  locator: '来源位置',
  score: '评分',
  field_path: '声明位置',
  evidence_refs: '证据引用',
  unchecked_rules: '未检查规则',
  rule_coverage: '规则覆盖',
  reply_body: '客服回复',
  internal_notes_zh: '内部处理说明',
  action: '建议动作',
  ticket_id: '工单标识',
  spend_minor: '花费（最小货币单位）',
  attributed_sales_minor: '归因销售额（最小货币单位）',
  impressions: '曝光',
  clicks: '点击',
  attributed_orders: '归因订单数',
  acos_ratio: 'ACoS（ratio）',
  roas: 'ROAS（ratio）',
  ctr_ratio: 'CTR（ratio）',
  cpc_minor: 'CPC（最小货币单位）',
  cvr_ratio: 'CVR（ratio）',
  candidates: '候选比较',
  constraints: '限制',
  next_steps: '下一步',
  requires_human_action: '需要人工处理',
};
export function UsageLine({ usage }: { usage: unknown }) {
  const item = asRecord(usage);
  return (
    <p className="text-xs leading-6 text-muted-foreground">
      模型：{textValue(item.model_ref)} · 输入 Token：
      {textValue(item.input_tokens)} · 输出 Token：
      {textValue(item.output_tokens)} · 重试：{textValue(item.retry_count)} ·
      费用：
      {item.cost_usd == null
        ? '未知（unknown）'
        : `$${textValue(item.cost_usd)}`}
    </p>
  );
}
export function Issues({ value }: { value: unknown }) {
  const issues = asRecords(value);
  return issues.length ? (
    <section
      aria-label="未检查项与问题"
      className="space-y-2 border-t border-border pt-4"
    >
      <h3 className="font-medium">未检查项与问题</h3>
      {issues.map((issue: EcomRecord, index: number) => (
        <div key={index} className="text-sm">
          <span className="font-medium">
            {textValue(issue.code ?? issue.severity)}
          </span>{' '}
          · {textValue(issue.message)}
          {issue.path != null && (
            <p className="break-words text-xs text-muted-foreground">
              {textValue(issue.path)}
            </p>
          )}
        </div>
      ))}
    </section>
  ) : null;
}
