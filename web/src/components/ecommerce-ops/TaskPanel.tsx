import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  asRecord,
  ecomRead,
  ecomRequest,
  textValue,
  type EcomArtifact,
  type EcomRecord,
  type EcomWorkspace,
} from '../../stores/ecommerce-ops';
import {
  assetId,
  reportId,
  DetailValue,
  Field,
  Issues,
  selectClass,
  UsageLine,
  useRequestKey,
  type RunAction,
} from './shared';

export const taskLabels: Record<string, string> = {
  research_brief: '候选研究',
  listing_pack: 'Listing 内容',
  ad_pack: '广告文案',
  ads_diagnosis: '广告诊断',
  support_draft: '客服草稿',
};
export const statusLabels: Record<string, string> = {
  queued: '排队中',
  freezing: '固定输入版本',
  retrieving: '检索证据',
  generating: '生成中',
  quality: '质检中',
  waiting_review: '等待人工审核',
  needs_input: '需要补充资料',
  blocked: '已阻断',
  failed: '执行失败',
  paused: '已暂停',
  cancelled: '已取消',
  completed: '任务已完成',
  draft: '草稿',
};
export function TaskPanel({
  data,
  workspaceId,
  busy,
  run,
  onArtifact,
}: {
  data: EcomWorkspace;
  workspaceId: string;
  busy: boolean;
  run: RunAction;
  onArtifact: (artifact: EcomArtifact) => void;
}) {
  const [taskType, setTaskType] = useState('listing_pack');
  const [market, setMarket] = useState('US');
  const [detail, setDetail] = useState<EcomRecord | null>(null);
  const requestKey = useRequestKey();
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const body: EcomRecord = {
      task_type: taskType,
      market,
      locale: market === 'US' ? 'en-US' : 'de-DE',
      product_ids: fields.getAll('product_ids'),
      asset_ids: fields.getAll('asset_ids'),
      report_ids: fields.getAll('report_ids'),
      query: fields.get('query') || undefined,
    };
    if (fields.get('as_of'))
      body.as_of = new Date(String(fields.get('as_of'))).toISOString();
    if (taskType === 'ad_pack') body.placement = fields.get('placement');
    if (taskType === 'support_draft')
      body.support = {
        workspace_id: workspaceId,
        market,
        locale: body.locale,
        as_of: body.as_of,
        ticket: {
          ticket_id: fields.get('ticket_id'),
          workspace_id: workspaceId,
          text: [
            fields.get('ticket_text'),
            fields.get('order_context'),
            fields.get('requested_action'),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      };
    void (async () => {
      const accepted = await run(async () => {
        const task = asRecord(
          await ecomRequest(workspaceId, '/tasks', {
            ...body,
            request_key: requestKey(body),
          }),
        );
        setDetail(asRecord(task.task ?? task));
      }, '任务已受理；请查看执行状态与缺料项');
      if (accepted) requestKey.reset();
    })();
  };
  const inspect = (task: EcomRecord) =>
    run(async () => {
      const response = asRecord(
        await ecomRead(
          workspaceId,
          `/tasks/${encodeURIComponent(textValue(task.id))}`,
        ),
      );
      const current = asRecord(response.task ?? response);
      setDetail(current);
      const artifact = response.artifact ?? current.artifact;
      if (asRecord(artifact).id) onArtifact(artifact as EcomArtifact);
    }, '');
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-base font-medium">创建任务</h2>
        <p className="text-sm text-muted-foreground">
          只生成草稿与诊断建议。资料不足时会等待补料，不会自动上架、调整广告、退款或发送消息。
        </p>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
          <Field label="任务类型">
            <select
              name="task_type"
              value={taskType}
              onChange={(event) => setTaskType(event.target.value)}
              className={selectClass}
            >
              {Object.entries(taskLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="任务站点">
            <select
              name="market"
              value={market}
              onChange={(event) => setMarket(event.target.value)}
              className={selectClass}
            >
              <option value="US">Amazon US · en-US · USD</option>
              <option value="DE">Amazon DE · de-DE · EUR</option>
            </select>
          </Field>
          <fieldset className="space-y-2 sm:col-span-2">
            <legend className="mb-2 text-sm">产品与版本</legend>
            {data.products.filter((product) => product.market === market)
              .length ? (
              data.products
                .filter((product) => product.market === market)
                .map((product) => (
                  <label
                    key={product.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted"
                  >
                    <input
                      type={
                        taskType === 'research_brief' ? 'checkbox' : 'radio'
                      }
                      name="product_ids"
                      value={product.id}
                    />
                    {product.sku} · v{product.revision} ·{' '}
                    {product.facts?.filter(
                      (f) => f.verification_state === 'confirmed',
                    ).length ?? 0}{' '}
                    项已确认事实
                  </label>
                ))
            ) : (
              <p className="text-sm text-muted-foreground">
                此站点尚无产品；请先在产品页添加。
              </p>
            )}
          </fieldset>
          <Field label="任务要求">
            <Textarea
              name="query"
              placeholder="说明目标、限制及需要回答的问题"
              className="min-h-24"
            />
          </Field>
          <Field label="资料截止时间（默认当前）">
            <Input name="as_of" type="datetime-local" />
          </Field>
          {!!data.assets.length && (
            <fieldset>
              <legend className="mb-2 text-sm">附件</legend>
              {data.assets
                .filter((asset) => !asset.market || asset.market === market)
                .map((asset) => (
                  <label
                    className="flex min-h-11 items-center gap-3 text-sm"
                    key={assetId(asset)}
                  >
                    <input
                      type="checkbox"
                      name="asset_ids"
                      value={assetId(asset)}
                    />
                    {textValue(asset.filename ?? asset.name)}
                  </label>
                ))}
            </fieldset>
          )}
          {taskType === 'ad_pack' && (
            <Field label="广告位置规则">
              <Input
                name="placement"
                required
                placeholder="填写适用广告位置 / profile"
              />
            </Field>
          )}
          {taskType === 'ads_diagnosis' && (
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-sm">选择已核对口径的报表</legend>
              {data.reports.length ? (
                data.reports.map((report) => (
                  <label
                    className="flex min-h-11 items-center gap-3 text-sm"
                    key={reportId(report)}
                  >
                    <input
                      type="checkbox"
                      name="report_ids"
                      value={reportId(report)}
                    />
                    {reportId(report)} ·{' '}
                    {textValue(asRecord(report.metadata).currency)} ·{' '}
                    {textValue(asRecord(report.metadata).granularity)}
                  </label>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  暂无报表。请先导入 CSV /
                  XLSX，再在下方确认币种、日期与归因窗口。
                </p>
              )}
            </fieldset>
          )}
          {taskType === 'support_draft' && (
            <>
              <Field label="工单标识">
                <Input required name="ticket_id" />
              </Field>
              <Field label="脱敏工单内容">
                <Textarea
                  required
                  name="ticket_text"
                  placeholder="删除姓名、邮箱、地址等个人信息"
                />
              </Field>
              <Field label="脱敏订单上下文">
                <Textarea
                  name="order_context"
                  placeholder="仅填写回答问题必要的信息"
                />
              </Field>
              <Field label="买家请求">
                <Input name="requested_action" placeholder="例如：申请退款" />
              </Field>
            </>
          )}
          <Button
            type="submit"
            disabled={busy}
            className="min-h-11 justify-self-start sm:col-span-2"
          >
            创建草稿任务
          </Button>
        </form>
      </section>
      {taskType === 'ads_diagnosis' && (
        <ReportForm
          data={data}
          workspaceId={workspaceId}
          busy={busy}
          run={run}
          market={market}
        />
      )}
      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-base font-medium">任务记录</h2>
        {data.tasks.length ? (
          <ul className="divide-y divide-border">
            {data.tasks.map((task) => (
              <li
                data-task-id={textValue(task.id)}
                key={textValue(task.id)}
                className="space-y-2 py-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {taskLabels[
                        textValue(
                          task.task_type ?? asRecord(task.request).task_type,
                        )
                      ] ??
                        textValue(
                          task.task_type ?? asRecord(task.request).task_type,
                        )}{' '}
                      ·{' '}
                      {textValue(task.market ?? asRecord(task.request).market)}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {statusLabels[textValue(task.status)] ??
                        textValue(task.status)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void inspect(task)}
                  >
                    查看任务与产物
                  </Button>
                </div>
                <UsageLine usage={task.usage} />
                {task.error != null && (
                  <p
                    role="alert"
                    className="break-words text-sm text-destructive"
                  >
                    {textValue(task.error)}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(['paused', 'needs_input', 'blocked', 'failed'].includes(
                    textValue(task.status),
                  ) ||
                    data.artifacts.some(
                      (artifact) =>
                        artifact.id === task.artifact_id && artifact.stale,
                    )) && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            ecomRequest(
                              workspaceId,
                              `/tasks/${encodeURIComponent(textValue(task.id))}/resume`,
                            ),
                          '已请求恢复；将重新检查依赖',
                        )
                      }
                    >
                      补料后恢复
                    </Button>
                  )}
                  {![
                    'completed',
                    'cancelled',
                    'failed',
                    'paused',
                    'waiting_review',
                  ].includes(textValue(task.status)) && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            ecomRequest(
                              workspaceId,
                              `/tasks/${encodeURIComponent(textValue(task.id))}/pause`,
                            ),
                          '已请求暂停',
                        )
                      }
                    >
                      暂停任务
                    </Button>
                  )}
                  {!['completed', 'cancelled'].includes(
                    textValue(task.status),
                  ) && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            ecomRequest(
                              workspaceId,
                              `/tasks/${encodeURIComponent(textValue(task.id))}/cancel`,
                            ),
                          '已请求取消',
                        )
                      }
                    >
                      取消任务
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">暂无任务。</p>
        )}
      </section>
      {detail && (
        <section
          className="space-y-4 border-t border-border pt-6"
          aria-label="当前任务详情"
        >
          <h3 className="font-medium">当前任务详情</h3>
          <p className="text-sm">
            {statusLabels[textValue(detail.status)] ?? textValue(detail.status)}{' '}
            · {textValue(detail.error ?? '')}
          </p>
          <Issues value={detail.issues} />
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-sm">
              输入依赖与执行记录
            </summary>
            <DetailValue
              value={{
                任务标识: detail.id,
                产品: asRecord(detail.request).product_ids,
                附件: asRecord(detail.request).asset_ids,
                报表: asRecord(detail.request).report_ids,
                输入版本: detail.input_revision,
                依赖版本: asRecord(detail.snapshot).dependencies,
                缺料与问题: asRecord(detail.snapshot).issues,
                创建时间: detail.created_at,
                更新时间: detail.updated_at,
              }}
            />
          </details>
        </section>
      )}
    </div>
  );
}
function ReportForm({
  data,
  workspaceId,
  busy,
  run,
  market,
}: {
  data: EcomWorkspace;
  workspaceId: string;
  busy: boolean;
  run: RunAction;
  market: string;
}) {
  return (
    <form
      className="grid gap-4 border-t border-border pt-6 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const nullableDays = (key: string) =>
          fields.get(key) === '' ? null : Number(fields.get(key));
        void run(
          () =>
            ecomRequest(workspaceId, '/reports', {
              asset_id: fields.get('asset_id'),
              mapping: fields.get('mapping'),
              metadata: {
                report_id: fields.get('report_id'),
                workspace_id: workspaceId,
                market,
                currency: market === 'US' ? 'USD' : 'EUR',
                timezone: fields.get('timezone'),
                account: fields.get('account'),
                ad_product: 'SP',
                advertiser_type: fields.get('advertiser_type'),
                attribution_window_days: nullableDays(
                  'attribution_window_days',
                ),
                reporting_delay_days: nullableDays('reporting_delay_days'),
                granularity: fields.get('granularity'),
                date_range: {
                  start: fields.get('start'),
                  end: fields.get('end'),
                },
                generated_at: new Date(
                  String(fields.get('generated_at')),
                ).toISOString(),
                provenance: fields.get('provenance'),
              },
            }),
          '报表已核对；指标由服务端统一计算',
        );
      }}
    >
      <h3 className="font-medium sm:col-span-2">
        核对广告报表口径 · {market === 'US' ? 'USD' : 'EUR'}
      </h3>
      <Field label="报表文件">
        <select
          required
          name="asset_id"
          defaultValue=""
          className={selectClass}
        >
          <option value="" disabled>
            选择已导入 CSV / XLSX
          </option>
          {data.assets
            .filter(
              (asset) => asset.kind === 'report' && asset.market === market,
            )
            .map((asset) => (
              <option value={assetId(asset)} key={assetId(asset)}>
                {textValue(asset.filename ?? asset.name)}
              </option>
            ))}
        </select>
      </Field>
      <Field label="列映射版本">
        <select name="mapping" className={selectClass}>
          <option value="sp-search-term-v1">SP 搜索词报表 v1</option>
          <option value="sp-campaign-v1">SP 活动报表 v1</option>
        </select>
      </Field>
      <Field label="报表标识">
        <Input required name="report_id" />
      </Field>
      <Field label="广告账户">
        <Input required name="account" />
      </Field>
      <Field label="报告时区">
        <Input
          required
          name="timezone"
          placeholder="例如：America/Los_Angeles"
        />
      </Field>
      <Field label="广告主类型">
        <select name="advertiser_type" className={selectClass}>
          <option value="seller">Seller</option>
          <option value="vendor">Vendor</option>
        </select>
      </Field>
      <Field label="报告开始日期">
        <Input required type="date" name="start" />
      </Field>
      <Field label="报告结束日期">
        <Input required type="date" name="end" />
      </Field>
      <Field label="归因窗口天数（未知留空）">
        <Input type="number" name="attribution_window_days" min="0" max="365" />
      </Field>
      <Field label="报告延迟天数（未知留空）">
        <Input type="number" name="reporting_delay_days" min="0" max="365" />
      </Field>
      <Field label="报告粒度">
        <select name="granularity" className={selectClass}>
          <option value="daily">每日</option>
          <option value="summary">汇总</option>
        </select>
      </Field>
      <Field label="报告生成时间">
        <Input required type="datetime-local" name="generated_at" />
      </Field>
      <Field label="报表数据来源">
        <select name="provenance" className={selectClass}>
          <option value="real">真实</option>
          <option value="redacted">已脱敏</option>
          <option value="synthetic">合成测试</option>
          <option value="public">公开</option>
        </select>
      </Field>
      <Button
        disabled={busy}
        type="submit"
        className="min-h-11 justify-self-start sm:col-span-2"
      >
        核对并导入报表
      </Button>
    </form>
  );
}
