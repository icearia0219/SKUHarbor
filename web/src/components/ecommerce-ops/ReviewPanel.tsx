import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { withBasePath } from '../../utils/url';
import {
  asRecord,
  asRecords,
  ecomRead,
  ecomRequest,
  errorMessage,
  textValue,
  useEcommerceAvailability,
  workspaceQuery,
  type EcomArtifact,
} from '../../stores/ecommerce-ops';
import {
  DetailValue,
  Field,
  fieldLabels,
  Issues,
  selectClass,
  UsageLine,
  useRequestKey,
} from './shared';

export function ReviewPanel({
  artifact,
  workspaceId,
  onChange,
}: {
  artifact: EcomArtifact;
  workspaceId: string;
  onChange: () => void;
}) {
  const enabled = useEcommerceAvailability((state) => state.enabled);
  const result = asRecord(artifact.result);
  const payload = asRecord(result.payload);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<unknown>(null);
  const [format, setFormat] = useState('json');
  const requestKey = useRequestKey();
  useEffect(() => {
    setEditing(false);
    setReason('');
    setError(null);
    setEvidence(null);
    setAwaitingRefresh(false);
  }, [artifact.id, artifact.revision, artifact.content_hash, workspaceId]);
  const current =
    !artifact.stale &&
    !awaitingRefresh &&
    !!artifact.content_hash &&
    Number.isInteger(artifact.revision);
  const canApprove =
    enabled &&
    current &&
    !editing &&
    ![...asRecords(result.issues), ...asRecords(artifact.quality)].some(
      (issue) => issue.severity === 'blocking',
    ) &&
    result.status === 'draft' &&
    !!reason.trim() &&
    !busy;
  const canExportApproved =
    enabled &&
    current &&
    !editing &&
    artifact.review?.valid === true &&
    artifact.review?.decision === 'approve' &&
    !busy;
  const perform = async (
    work: () => Promise<unknown>,
    message: string,
    refresh = true,
  ) => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work();
      setNotice(message);
      if (refresh) onChange();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const review = (decision: 'approve' | 'reject') => {
    const body = {
      expected_revision: artifact.revision,
      content_hash: artifact.content_hash,
      decision,
      reason: reason.trim(),
    };
    void perform(
      () =>
        ecomRequest(
          workspaceId,
          `/artifacts/${encodeURIComponent(artifact.id)}/review`,
          { ...body, request_key: requestKey(body) },
        ),
      decision === 'approve'
        ? '审核请求已保存；以服务端版本校验结果为准'
        : '已退回修改',
    );
  };
  const download = (mode: 'preview' | 'approved') =>
    perform(
      async () => {
        if (!enabled || (mode === 'approved' && !canExportApproved))
          throw new Error('当前版本尚未取得有效审核');
        const path = `/api/ecommerce-ops/artifacts/${encodeURIComponent(artifact.id)}/export?${workspaceQuery(workspaceId)}&revision=${artifact.revision}&format=${format}&mode=${mode}`;
        const response = await fetch(withBasePath(path), {
          credentials: 'include',
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(textValue(body.error ?? response.statusText));
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        const disposition = response.headers.get('Content-Disposition') ?? '';
        const name = disposition.match(/filename="?([^";]+)"?/i)?.[1];
        link.download =
          name ??
          `${artifact.id}-${mode}.${format === 'markdown' ? 'md' : format}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      mode === 'preview'
        ? '预览文件已下载，请保留未审 / 失效标记'
        : '已下载服务端校验通过的审核版本',
      false,
    );
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">
            {artifact.stale ? '已失效 · 需要重新生成或确认' : '当前产物'}
          </h3>
          <span className="text-xs text-muted-foreground">
            版本 {artifact.revision} · {textValue(result.status)}
          </span>
        </div>
        <dl className="space-y-2 text-xs text-muted-foreground">
          <div>
            <dt>内容 Hash</dt>
            <dd className="break-all font-mono text-foreground">
              {artifact.content_hash}
            </dd>
          </div>
          <div>
            <dt>输入版本</dt>
            <dd className="break-all">
              {textValue(artifact.input_revision ?? result.input_revision)}
            </dd>
          </div>
          <div>
            <dt>规则快照</dt>
            <dd className="break-all">
              {textValue(
                artifact.policy_snapshot_id ?? result.policy_snapshot_id,
              )}
            </dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          {artifact.review?.valid ? '服务端审核有效' : '当前版本尚无有效审核'}
          。修改内容或依赖版本后，必须重新审核。
        </p>
        <UsageLine usage={result.usage} />
      </section>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <section className="space-y-4 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">内容草稿</h3>
          <Button
            variant="outline"
            disabled={!enabled || busy || artifact.stale}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? '放弃编辑' : '编辑内容'}
          </Button>
        </div>
        {editing ? (
          <PayloadEditor
            key={`${artifact.id}:${artifact.revision}`}
            payload={payload}
            busy={busy}
            onSave={(next) =>
              void perform(async () => {
                await ecomRequest(
                  workspaceId,
                  `/artifacts/${encodeURIComponent(artifact.id)}`,
                  { expected_revision: artifact.revision, payload: next },
                  'patch',
                );
                setAwaitingRefresh(true);
                setEditing(false);
              }, '修改已保存；旧审核失效，已重新质检')
            }
          />
        ) : result.task_type === 'ads_diagnosis' && result.payload ? (
          <>
            <MetricsSnapshot metrics={asRecord(payload.metrics)} />
            <DetailValue
              value={Object.fromEntries(
                Object.entries(payload).filter(([key]) => key !== 'metrics'),
              )}
            />
          </>
        ) : (
          <DetailValue value={result.payload} />
        )}
      </section>
      <Issues
        value={[...asRecords(result.issues), ...asRecords(artifact.quality)]}
      />
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="font-medium">声明与证据</h3>
        {asRecords(result.claims).length ? (
          asRecords(result.claims).map((claim, index) => (
            <div key={index} className="space-y-2 text-sm">
              <DetailValue value={claim} />
              {Array.isArray(claim.evidence_refs) &&
                claim.evidence_refs.map((id) => (
                  <Button
                    key={textValue(id)}
                    variant="link"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        async () =>
                          setEvidence(
                            await ecomRead(
                              workspaceId,
                              `/evidence/${encodeURIComponent(textValue(id))}`,
                            ),
                          ),
                        '',
                        false,
                      )
                    }
                  >
                    定位证据 {textValue(id)}
                  </Button>
                ))}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            没有可核对的声明；请检查未检查项。
          </p>
        )}
        {asRecords(result.evidence).map((item) => (
          <div className="space-y-1 text-sm" key={textValue(item.evidence_id)}>
            <p className="break-words">
              {textValue(item.locator)} · {textValue(item.provenance)}
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {textValue(item.excerpt)}
            </p>
            <Button
              variant="link"
              disabled={busy}
              onClick={() =>
                void perform(
                  async () =>
                    setEvidence(
                      await ecomRead(
                        workspaceId,
                        `/evidence/${encodeURIComponent(textValue(item.evidence_id))}`,
                      ),
                    ),
                  '',
                  false,
                )
              }
            >
              读取授权原文
            </Button>
          </div>
        ))}
        {evidence !== null && (
          <div className="border-l border-border pl-3" aria-label="证据原文">
            <DetailValue value={evidence} />
          </div>
        )}
      </section>
      {!!artifact.dependencies && (
        <details className="border-t border-border pt-4 text-sm">
          <summary className="min-h-11 cursor-pointer py-2">
            依赖版本与失效原因
          </summary>
          <DetailValue value={artifact.dependencies} />
        </details>
      )}
      <section className="space-y-4 border-t border-border pt-4">
        <h3 className="font-medium">审核当前版本</h3>
        <Field label="审核理由">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明证据、规则与人工确认依据"
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={!canApprove}
            onClick={() => review('approve')}
            className="min-h-11"
          >
            通过审核
          </Button>
          <Button
            variant="outline"
            disabled={!enabled || busy || editing || !reason.trim() || !current}
            onClick={() => review('reject')}
            className="min-h-11"
          >
            退回修改
          </Button>
        </div>
        {artifact.review && (
          <div className="space-y-2 text-sm">
            <p>
              {artifact.review.decision === 'approve'
                ? '人工审核通过'
                : '已退回'}{' '}
              · 审核版本 {textValue(artifact.review.revision)} ·{' '}
              {artifact.review.valid ? '当前有效' : '已失效'}
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {textValue(artifact.review.reason)}
            </p>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-xs text-muted-foreground">
                审核记录
              </summary>
              <DetailValue
                value={{
                  审核人: artifact.review.reviewer,
                  审核时间: artifact.review.created_at,
                  '审核内容 Hash': artifact.review.content_hash,
                }}
              />
            </details>
          </div>
        )}
      </section>
      <section className="space-y-4 border-t border-border pt-4">
        <h3 className="font-medium">导出</h3>
        <p className="text-sm text-muted-foreground">
          未审或失效内容仅供预览。正式导出由服务端再次核对版本、Hash 与审核。
        </p>
        <Field label="导出格式">
          <select
            className={selectClass}
            value={format}
            onChange={(event) => setFormat(event.target.value)}
          >
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
            {result.task_type === 'ads_diagnosis' && (
              <option value="csv">CSV</option>
            )}
          </select>
        </Field>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={!enabled || busy || editing}
            onClick={() => void download('preview')}
            className="min-h-11"
          >
            预览导出
          </Button>
          <Button
            data-export-approved
            disabled={!canExportApproved}
            onClick={() => void download('approved')}
            className="min-h-11"
          >
            导出已审核版本
          </Button>
        </div>
      </section>
      <form
        className="space-y-4 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const body = {
            expected_revision: artifact.revision,
            criteria: String(fields.get('criteria'))
              .split('\n')
              .filter(Boolean),
            due_at: new Date(String(fields.get('due_at'))).toISOString(),
          };
          void perform(
            () =>
              ecomRequest(
                workspaceId,
                `/artifacts/${encodeURIComponent(artifact.id)}/follow-up`,
                { ...body, request_key: requestKey(body) },
              ),
            '跟进目标已建立，需手动推进；不会自动执行广告或客服操作',
          );
        }}
      >
        <h3 className="font-medium">后续跟进</h3>
        <Field label="验收条件（每行一项）">
          <Textarea name="criteria" required />
        </Field>
        <Field label="跟进时间">
          <Input required name="due_at" type="datetime-local" />
        </Field>
        <Button
          type="submit"
          variant="outline"
          disabled={!canExportApproved}
          className="min-h-11"
        >
          创建跟进目标
        </Button>
      </form>
    </div>
  );
}
function MetricsSnapshot({ metrics }: { metrics: Record<string, unknown> }) {
  const rows = [
    ['acos_ratio', 'spend_minor', 'attributed_sales_minor'],
    ['roas', 'attributed_sales_minor', 'spend_minor'],
    ['ctr_ratio', 'clicks', 'impressions'],
    ['cpc_minor', 'spend_minor', 'clicks'],
    ['cvr_ratio', 'attributed_orders', 'clicks'],
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm">
        币种：{textValue(metrics.currency)} · 原始金额单位：最小货币单位
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">服务端计算的广告指标与分子分母</caption>
          <thead>
            <tr className="border-b border-border">
              <th className="py-3 pr-4 font-medium">指标</th>
              <th className="py-3 pr-4 font-medium">分子</th>
              <th className="py-3 pr-4 font-medium">分母</th>
              <th className="py-3 font-medium">服务端结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, numerator, denominator]) => (
              <tr key={key} className="border-b border-border">
                <th className="py-3 pr-4 font-normal">
                  {fieldLabels[key] ?? key}
                </th>
                <td className="py-3 pr-4">
                  <span className="block text-muted-foreground">
                    {fieldLabels[numerator]}
                  </span>
                  {textValue(metrics[numerator])}
                </td>
                <td className="py-3 pr-4">
                  <span className="block text-muted-foreground">
                    {fieldLabels[denominator]}
                  </span>
                  {textValue(metrics[denominator])}
                </td>
                <td className="py-3">
                  {metrics[key] == null
                    ? '未知 / 不可计算'
                    : textValue(metrics[key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        原始 ratio
        不在此处重算；空值保持未知，请结合归因成熟度、源行与缺失上下文阅读。
      </p>
    </div>
  );
}
function PayloadEditor({
  payload,
  busy,
  onSave,
}: {
  payload: Record<string, unknown>;
  busy: boolean;
  onSave: (next: Record<string, unknown>) => void;
}) {
  const [error, setError] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget),
          next: Record<string, unknown> = {};
        try {
          for (const [key, original] of Object.entries(payload)) {
            const text = String(fields.get(key) ?? '');
            next[key] =
              typeof original === 'string'
                ? text
                : Array.isArray(original) &&
                    original.every((value) => typeof value === 'string')
                  ? text
                    ? text.split('\n')
                    : []
                  : JSON.parse(text);
          }
          setError('');
          onSave(next);
        } catch {
          setError('结构化字段不是有效 JSON，请保留原有结构后重试。');
        }
      }}
    >
      {Object.entries(payload).map(([key, value]) => (
        <Field
          key={key}
          label={`${fieldLabels[key] ?? key}${typeof value !== 'string' && !(Array.isArray(value) && value.every((v) => typeof v === 'string')) ? '（JSON）' : Array.isArray(value) ? '（每行一项）' : ''}`}
        >
          <Textarea
            name={key}
            defaultValue={
              typeof value === 'string'
                ? value
                : Array.isArray(value) &&
                    value.every((v) => typeof v === 'string')
                  ? value.join('\n')
                  : JSON.stringify(value, null, 2)
            }
            className="min-h-24"
          />
        </Field>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        保存将生成新版本、撤销当前审核并重新质检。
      </p>
      <Button
        type="submit"
        disabled={busy || !Object.keys(payload).length}
        className="min-h-11"
      >
        保存修改并重新质检
      </Button>
    </form>
  );
}
