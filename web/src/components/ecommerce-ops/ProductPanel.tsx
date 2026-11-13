import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  asRecord,
  asRecords,
  ecomRead,
  ecomRequest,
  textValue,
  type EcomProduct,
  type EcomRecord,
  type EcomWorkspace,
} from '../../stores/ecommerce-ops';
import {
  assetId,
  downloadSource,
  DetailValue,
  Field,
  selectClass,
  useRequestKey,
  type RunAction,
} from './shared';

export function ProductPanel({
  data,
  workspaceId,
  busy,
  run,
}: {
  data: EcomWorkspace;
  workspaceId: string;
  busy: boolean;
  run: RunAction;
}) {
  const [market, setMarket] = useState('US');
  const [selected, setSelected] = useState<EcomProduct | null>(null);
  const [candidates, setCandidates] = useState<Record<string, EcomRecord[]>>(
    {},
  );
  const [source, setSource] = useState<unknown>(null);
  const requestKey = useRequestKey();
  const importInstants = useRef(new Map<string, string>());
  const locale = market === 'US' ? 'en-US' : 'de-DE';
  const isMobile = useMediaQuery('(max-width: 767px)');
  useEffect(() => {
    const fresh = data.products.find((product) => product.id === selected?.id);
    if (fresh && fresh.revision !== selected?.revision) setSelected(fresh);
  }, [data.products, selected?.id, selected?.revision]);
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void run(
      () =>
        ecomRequest(workspaceId, '/products', {
          product: {
            sku: fields.get('sku'),
            market,
            locale,
            product_type: fields.get('product_type'),
            seller_scope: fields.get('seller_scope'),
          },
        }),
      '产品已保存',
    );
  };
  const upload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget),
      file = fields.get('file') as File;
    const product = data.products.find(
      (p) => p.id === fields.get('product_id'),
    );
    void run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const key = requestKey({
        name: file.name,
        size: file.size,
        modified: file.lastModified,
        product: product?.id,
        market,
        kind: fields.get('kind'),
        provenance: fields.get('provenance'),
        version: fields.get('version'),
        rights: fields.get('rights_note'),
      });
      const now = importInstants.current.get(key) ?? new Date().toISOString();
      importInstants.current.set(key, now);
      const body = {
        name: file.name,
        format: file.name.split('.').pop()?.toLowerCase(),
        content_base64: btoa(binary),
        metadata: {
          source_id: file.name,
          kind: fields.get('kind'),
          provenance: fields.get('provenance'),
          owner_scope: workspaceId,
          market: product?.market ?? market,
          locale: product?.locale ?? locale,
          product_refs: product
            ? [
                {
                  product_id: product.id,
                  sku: product.sku,
                  market: product.market,
                  revision: String(product.revision),
                },
              ]
            : [],
          observed_at: now,
          known_at: now,
          effective_from: null,
          effective_to: null,
          version: fields.get('version'),
          rights_note: fields.get('rights_note'),
          source_url: null,
        },
      };
      // Stable key across retries of the same file/target; generated timestamps do not change identity.
      const response = asRecord(
        await ecomRequest(workspaceId, '/assets', {
          ...body,
          request_key: key,
        }),
      );
      const found = asRecords(response.candidates);
      if (product && found.length) {
        setCandidates((previous) => ({ ...previous, [product.id]: found }));
        setSelected(product);
      }
      const errors = asRecords(response.row_errors ?? response.errors);
      if (errors.length) setSource({ 导入问题: errors });
      return response;
    }, '导入结果已返回；请检查候选事实和导入问题');
  };
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-base font-medium">产品与事实</h2>
        {data.products.length ? (
          <ul className="divide-y divide-border">
            {data.products.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="flex min-h-16 w-full flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setSelected(product);
                    setSource(null);
                  }}
                >
                  <span className="font-medium">
                    {product.sku}
                    <span className="ml-3 text-sm font-normal text-muted-foreground">
                      Amazon {product.market} · {product.locale}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    版本 {product.revision} · {product.facts?.length ?? 0}{' '}
                    项事实 · 查看来源与确认
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            还没有产品。先建立 SKU 与站点，再导入规格资料。
          </p>
        )}
        <form
          onSubmit={create}
          className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Field label="SKU">
            <Input name="sku" required maxLength={160} />
          </Field>
          <Field label="站点">
            <select
              name="market"
              className={selectClass}
              value={market}
              onChange={(event) => setMarket(event.target.value)}
            >
              <option value="US">美国 · en-US · USD</option>
              <option value="DE">德国 · de-DE · EUR</option>
            </select>
          </Field>
          <Field label="产品类型">
            <Input
              name="product_type"
              required
              placeholder="例如：water_bottle"
            />
          </Field>
          <Field label="卖家适用范围">
            <Input name="seller_scope" required defaultValue="seller" />
          </Field>
          <Button
            disabled={busy}
            className="min-h-11 justify-self-start"
            type="submit"
          >
            添加产品
          </Button>
        </form>
      </section>
      <section className="space-y-4 border-t border-border pt-6">
        <h2 className="text-base font-medium">导入资料</h2>
        <p className="text-sm text-muted-foreground">
          支持 CSV、JSON、文本、可读 PDF / DOCX 与广告
          XLSX。扫描件或坏行会返回具体问题。
        </p>
        <form onSubmit={upload} className="grid gap-4 sm:grid-cols-2">
          <Field label="资料文件">
            <Input
              name="file"
              type="file"
              required
              accept=".csv,.json,.txt,.md,.pdf,.docx,.xlsx"
            />
          </Field>
          <Field label="关联产品">
            <select name="product_id" className={selectClass}>
              <option value="">共享资料（当前站点）</option>
              {data.products.map((product) => (
                <option value={product.id} key={product.id}>
                  {product.sku} · {product.market} · v{product.revision}
                </option>
              ))}
            </select>
          </Field>
          <Field label="资料类型">
            <select name="kind" className={selectClass}>
              <option value="product_fact">产品规格</option>
              <option value="policy">政策</option>
              <option value="brand">品牌规范</option>
              <option value="competitor">候选资料</option>
              <option value="report">广告报表</option>
              <option value="ticket">脱敏工单</option>
              <option value="order">订单资料</option>
              <option value="experience">经验资料</option>
            </select>
          </Field>
          <Field label="数据来源">
            <select name="provenance" className={selectClass}>
              <option value="real">真实资料</option>
              <option value="redacted">已脱敏资料</option>
              <option value="public">公开资料</option>
              <option value="synthetic">合成测试资料</option>
            </select>
          </Field>
          <Field label="来源版本">
            <Input name="version" required placeholder="例如：2026-11-12" />
          </Field>
          <Field label="授权与使用说明">
            <Input
              name="rights_note"
              required
              placeholder="说明资料的来源和使用权"
            />
          </Field>
          <Button
            disabled={busy}
            className="min-h-11 justify-self-start"
            type="submit"
          >
            导入资料
          </Button>
        </form>
        {!!data.assets.length && (
          <ul className="divide-y divide-border">
            {data.assets.map((asset) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
                key={textValue(asset.id ?? asset.source_id)}
              >
                <span>
                  {textValue(asset.filename ?? asset.name)} ·{' '}
                  {textValue(asset.market)} · v{textValue(asset.version)}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await downloadSource(
                        `/api/ecommerce-ops/assets/${encodeURIComponent(assetId(asset))}/content?workspace_id=${encodeURIComponent(workspaceId)}`,
                        textValue(asset.filename ?? asset.name),
                      );
                    }, '')
                  }
                >
                  下载原文
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Sheet
        open={selected !== null || source !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setSource(null);
          }
        }}
      >
        <SheetContent
          side={isMobile ? 'bottom' : 'right'}
          className="max-h-[90dvh] overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        >
          <SheetHeader>
            <SheetTitle>
              {source !== null
                ? '资料原文与导入问题'
                : `${selected?.sku ?? ''} · 事实确认`}
            </SheetTitle>
            <SheetDescription>
              确认具体值、来源和理由；不同站点与版本分别保留。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 p-4 pt-0">
            {source !== null ? (
              <DetailValue value={source} />
            ) : (
              selected && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Amazon {selected.market} · 版本 {selected.revision}
                  </p>
                  {[
                    ...(selected.facts ?? []),
                    ...(candidates[selected.id] ?? []),
                  ].map((fact, index) => (
                    <div
                      className="border-b border-border pb-4 text-sm"
                      key={index}
                    >
                      <DetailValue value={fact} />
                      {typeof fact.evidence_id === 'string' && (
                        <Button
                          variant="link"
                          onClick={() =>
                            void run(
                              async () =>
                                setSource(
                                  await ecomRead(
                                    workspaceId,
                                    `/evidence/${encodeURIComponent(fact.evidence_id as string)}`,
                                  ),
                                ),
                              '',
                            )
                          }
                        >
                          查看证据原文
                        </Button>
                      )}
                    </div>
                  ))}
                  <FactConfirmation
                    key={selected.id}
                    product={selected}
                    candidates={candidates[selected.id] ?? []}
                    busy={busy}
                    onConfirm={(body) =>
                      run(async () => {
                        const response = asRecord(
                          await ecomRequest(
                            workspaceId,
                            `/products/${encodeURIComponent(selected.id)}/confirm`,
                            body,
                          ),
                        );
                        const product = asRecord(response.product ?? response);
                        if (typeof product.id === 'string')
                          setSelected(product as EcomProduct);
                        setCandidates((previous) => ({
                          ...previous,
                          [selected.id]: [],
                        }));
                      }, '事实确认已保存；依赖此事实的旧产物将由服务端标记失效')
                    }
                  />
                </>
              )
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
function FactConfirmation({
  product,
  candidates,
  busy,
  onConfirm,
}: {
  product: EcomProduct;
  candidates: EcomRecord[];
  busy: boolean;
  onConfirm: (body: EcomRecord) => Promise<boolean>;
}) {
  const [candidateIndex, setCandidateIndex] = useState('');
  const choices = [
    ...new Map(
      [...(product.facts ?? []), ...candidates].map((fact) => [
        textValue(fact.evidence_id),
        fact,
      ]),
    ).values(),
  ];
  const candidate =
    candidateIndex === '' ? undefined : choices[Number(candidateIndex)];
  return (
    <form
      key={`${product.id}:${candidateIndex}`}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        if (!candidate) return;
        const reason = textValue(fields.get('reason'));
        void onConfirm({
          expected_revision: product.revision,
          reason,
          decisions: [
            {
              field: candidate.field,
              value: candidate.value,
              unit: candidate.unit ?? null,
              evidence_id: candidate.evidence_id,
              verification_state: fields.get('verification_state'),
              reason,
            },
          ],
        });
      }}
    >
      <h3 className="font-medium">逐项确认或撤回事实</h3>
      <p className="text-xs text-muted-foreground">
        从来源候选中选择具体值。更正规格请导入新资料，再确认对应证据。
      </p>
      <Field label="选择候选值">
        <select
          required
          className={selectClass}
          value={candidateIndex}
          onChange={(event) => setCandidateIndex(event.target.value)}
        >
          <option value="">选择原始来源值</option>
          {choices.map((fact, index) => (
            <option value={index} key={index}>
              {textValue(fact.field)} = {textValue(fact.value)} ·{' '}
              {textValue(fact.unit)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="事实字段">
        <Input readOnly value={candidate ? textValue(candidate.field) : ''} />
      </Field>
      <Field label="具体值">
        <Input readOnly value={candidate ? textValue(candidate.value) : ''} />
      </Field>
      <Field label="单位">
        <Input
          readOnly
          value={candidate?.unit ? textValue(candidate.unit) : ''}
        />
      </Field>
      <Field label="证据 ID">
        <Input
          readOnly
          value={candidate ? textValue(candidate.evidence_id) : ''}
        />
      </Field>
      <Field label="确认结果">
        <select name="verification_state" className={selectClass}>
          <option value="confirmed">确认此值</option>
          <option value="rejected">拒绝此候选</option>
        </select>
      </Field>
      <Field label="确认理由">
        <Input name="reason" required />
      </Field>
      <Button type="submit" disabled={busy || !candidate} className="min-h-11">
        保存事实确认
      </Button>
    </form>
  );
}
