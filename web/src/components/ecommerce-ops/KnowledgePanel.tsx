import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ecomRequest,
  textValue,
  type EcomRecord,
  type EcomWorkspace,
} from '../../stores/ecommerce-ops';
import {
  assetId,
  DetailValue,
  Field,
  selectClass,
  type RunAction,
} from './shared';

export function KnowledgePanel({
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
  const [editing, setEditing] = useState<EcomRecord | null>(null);
  const editText = (key: string) =>
    editing?.[key] == null ? '' : String(editing[key]);
  const editTime = (key: string) => {
    if (!editText(key)) return '';
    const date = new Date(editText(key));
    return Number.isFinite(date.getTime())
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : '';
  };
  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h2 className="text-base font-medium">适用知识</h2>
        <p className="text-sm text-muted-foreground">
          按站点、产品类型、卖家范围与有效期选择资料。未知有效期会明确保留，不视为长期有效。
        </p>
        {data.knowledge.length ? (
          <ul className="divide-y divide-border">
            {data.knowledge.map((item) => (
              <li key={textValue(item.id)} className="space-y-2 py-4">
                <p className="text-sm font-medium">
                  {textValue(item.market)} · {textValue(item.product_type)} · v
                  {textValue(item.version ?? item.revision)}
                </p>
                <p className="text-xs text-muted-foreground">
                  权威：{textValue(item.authority)} · 审核：
                  {textValue(item.approval_state)} · 适用：
                  {textValue(item.seller_scope)}
                </p>
                <p className="text-xs text-muted-foreground">
                  有效期：{textValue(item.effective_from)} —{' '}
                  {textValue(item.effective_to)} · 已知时间：
                  {textValue(item.known_at)}
                </p>
                <details className="text-sm">
                  <summary className="min-h-11 cursor-pointer py-2">
                    查看范围与证据
                  </summary>
                  <DetailValue value={item} />
                </details>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setMarket(String(item.market));
                  }}
                >
                  更新此知识版本
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            暂无知识。先在产品页导入政策或品牌资料，再登记适用范围。
          </p>
        )}
      </section>
      <form
        key={editing ? `${editing.id}:${editing.revision}` : 'new'}
        className="grid gap-4 border-t border-border pt-6 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const instant = (name: string) =>
            fields.get(name)
              ? new Date(String(fields.get(name))).toISOString()
              : null;
          void run(
            () =>
              ecomRequest(workspaceId, '/knowledge', {
                asset_id: fields.get('asset_id'),
                expected_revision: editing ? Number(editing.revision) : 0,
                metadata: {
                  id: fields.get('id'),
                  market,
                  locale: market === 'US' ? 'en-US' : 'de-DE',
                  product_type: fields.get('product_type'),
                  seller_scope: fields.get('seller_scope'),
                  authority: fields.get('authority'),
                  approval_state: fields.get('approval_state'),
                  effective_from: instant('effective_from'),
                  effective_to: instant('effective_to'),
                  known_at: new Date().toISOString(),
                  version: fields.get('version'),
                },
              }),
            '知识范围已登记；旧规则依赖将由服务端检查',
          ).then((saved) => {
            if (saved) setEditing(null);
          });
        }}
      >
        <h3 className="font-medium sm:col-span-2">
          {editing ? '更新知识范围与版本' : '登记知识适用性'}
        </h3>
        <Field label="已导入资料">
          <select
            key={market}
            required
            name="asset_id"
            className={selectClass}
            defaultValue={editText('asset_id')}
          >
            <option value="" disabled>
              选择资料
            </option>
            {data.assets
              .filter((asset) => asset.market === market)
              .map((asset) => (
                <option value={assetId(asset)} key={assetId(asset)}>
                  {textValue(asset.filename ?? asset.name)} ·{' '}
                  {textValue(asset.market)}
                </option>
              ))}
          </select>
        </Field>
        <Field label="知识站点">
          <select
            value={market}
            disabled={!!editing}
            onChange={(event) => setMarket(event.target.value)}
            className={selectClass}
          >
            <option value="US">Amazon US · en-US</option>
            <option value="DE">Amazon DE · de-DE</option>
          </select>
        </Field>
        <Field label="适用产品类型">
          <Input
            required
            name="product_type"
            defaultValue={editText('product_type')}
          />
        </Field>
        <Field label="知识标识">
          <Input
            required
            name="id"
            readOnly={!!editing}
            defaultValue={editText('id')}
            placeholder="为此适用规则设置稳定标识"
          />
        </Field>
        <Field label="适用卖家范围">
          <Input
            required
            name="seller_scope"
            defaultValue={editText('seller_scope') || 'seller'}
          />
        </Field>
        <Field label="来源权威">
          <select
            required
            name="authority"
            defaultValue={editText('authority')}
            className={selectClass}
          >
            <option disabled value="">
              确认来源权威
            </option>
            <option value="official">官方规则</option>
            <option value="manufacturer">制造商资料</option>
            <option value="merchant">商家资料</option>
            <option value="experience">经验资料</option>
          </select>
        </Field>
        <Field label="审核状态">
          <select
            name="approval_state"
            defaultValue={editText('approval_state') || 'pending'}
            className={selectClass}
          >
            <option value="pending">待审核</option>
            <option value="approved">已人工确认适用</option>
            <option value="withdrawn">已撤回</option>
          </select>
        </Field>
        <Field label="知识版本">
          <Input required name="version" defaultValue={editText('version')} />
        </Field>
        <Field label="生效时间（未知可留空）">
          <Input
            name="effective_from"
            type="datetime-local"
            defaultValue={editTime('effective_from')}
          />
        </Field>
        <Field label="失效时间（未知可留空）">
          <Input
            name="effective_to"
            type="datetime-local"
            defaultValue={editTime('effective_to')}
          />
        </Field>
        <Button
          type="submit"
          disabled={busy || !data.assets.length}
          className="min-h-11 justify-self-start"
        >
          保存知识范围
        </Button>
        {editing && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setEditing(null)}
          >
            返回新建知识
          </Button>
        )}
      </form>
    </div>
  );
}
