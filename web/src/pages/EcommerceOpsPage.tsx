import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/common/PageHeader';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { useGroupsStore } from '../stores/groups';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  ecomRead,
  errorMessage,
  textValue,
  useEcommerceAvailability,
  useEcommerceOpsStore,
  type EcomArtifact,
  type EcomWorkspace,
} from '../stores/ecommerce-ops';
import { ProductPanel } from '../components/ecommerce-ops/ProductPanel';
import { KnowledgePanel } from '../components/ecommerce-ops/KnowledgePanel';
import { TaskPanel, taskLabels } from '../components/ecommerce-ops/TaskPanel';
import { ReviewPanel } from '../components/ecommerce-ops/ReviewPanel';
import {
  Field,
  selectClass,
  type RunAction,
} from '../components/ecommerce-ops/shared';

export function EcommerceOpsPage() {
  const availability = useEcommerceAvailability();
  const groups = useGroupsStore((state) => state.groups);
  const loadGroups = useGroupsStore((state) => state.loadGroups);
  const store = useEcommerceOpsStore();
  const [params, setParams] = useSearchParams();
  const requested = params.get('workspace_id') ?? '';
  const workspaceId = Object.prototype.hasOwnProperty.call(groups, requested)
    ? requested
    : '';
  useEffect(() => {
    void availability.load();
  }, [availability.load]);
  useEffect(() => {
    if (availability.enabled) void loadGroups();
  }, [availability.enabled, loadGroups]);
  useEffect(() => {
    if (availability.enabled && workspaceId) void store.load(workspaceId);
    else store.clear();
  }, [availability.enabled, workspaceId, store.load, store.clear]);
  const active = store.data?.tasks.some((task) =>
    ['queued', 'freezing', 'retrieving', 'generating', 'quality'].includes(
      textValue(task.status),
    ),
  );
  useEffect(() => {
    if (!active || !workspaceId || !availability.enabled) return;
    const timer = setInterval(() => void store.load(workspaceId), 3000);
    return () => clearInterval(timer);
  }, [active, workspaceId, availability.enabled, store.load]);
  if (!availability.checked)
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        正在检查电商运营可用性…
      </div>
    );
  if (!availability.enabled)
    return (
      <section className="p-6">
        <h1 className="product-page-title">电商运营尚未开启</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          当前无法读取或提交电商任务。可继续使用会话与我的工作。
        </p>
      </section>
    );
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        title="电商运营"
        subtitle="Amazon US / DE · 从产品事实到可核对的草稿"
        actions={
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新工作区"
            disabled={!workspaceId || store.loading}
            onClick={() => void store.load(workspaceId)}
          >
            <RefreshCw className="size-4" />
          </Button>
        }
      />
      <div className="max-w-md">
        <Field label="工作区">
          <select
            aria-label="工作区"
            className={selectClass}
            value={workspaceId}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value)
                next.set('workspace_id', event.target.value);
              else next.delete('workspace_id');
              setParams(next, { replace: true });
            }}
          >
            <option value="">选择可访问的工作区</option>
            {Object.entries(groups).map(([jid, group]) => (
              <option value={jid} key={jid}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {store.error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {store.error}
        </p>
      )}
      {!workspaceId ? (
        <p className="border-t border-border py-8 text-sm text-muted-foreground">
          先选择工作区。产品、资料、任务与审核按工作区分别保存。
        </p>
      ) : store.loading && !store.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取产品与任务…
        </p>
      ) : store.data && store.workspaceId === workspaceId ? (
        <Workspace
          key={workspaceId}
          data={store.data}
          workspaceId={workspaceId}
          reload={() => store.load(workspaceId)}
        />
      ) : null}
    </div>
  );
}
function Workspace({
  data,
  workspaceId,
  reload,
}: {
  data: EcomWorkspace;
  workspaceId: string;
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fallback, setFallback] = useState<EcomArtifact | null>(null);
  const [tab, setTab] = useState('products');
  const isMobile = useMediaQuery('(max-width: 767px)');
  const selected =
    data.artifacts.find((artifact) => artifact.id === selectedId) ?? fallback;
  const run: RunAction = async (work, success = '已保存') => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await work();
      await reload();
      setNotice(success);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const viewArtifact = (artifact: EcomArtifact) => {
    setSelectedId(artifact.id);
    setFallback(artifact);
  };
  return (
    <>
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
      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <div className="overflow-x-auto border-b border-border pb-2">
          <TabsList variant="line" aria-label="电商工作台">
            <TabsTrigger value="products" className="min-h-11 px-4">
              产品
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="min-h-11 px-4">
              知识
            </TabsTrigger>
            <TabsTrigger value="tasks" className="min-h-11 px-4">
              任务
            </TabsTrigger>
            <TabsTrigger value="review" className="min-h-11 px-4">
              审核
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="products">
          <ProductPanel
            data={data}
            workspaceId={workspaceId}
            busy={busy}
            run={run}
          />
        </TabsContent>
        <TabsContent value="knowledge">
          <KnowledgePanel
            data={data}
            workspaceId={workspaceId}
            busy={busy}
            run={run}
          />
        </TabsContent>
        <TabsContent value="tasks">
          <TaskPanel
            data={data}
            workspaceId={workspaceId}
            busy={busy}
            run={run}
            onArtifact={viewArtifact}
          />
        </TabsContent>
        <TabsContent value="review">
          <section className="space-y-4">
            <h2 className="text-base font-medium">版本审核与交付</h2>
            {data.artifacts.length ? (
              <ul className="divide-y divide-border">
                {data.artifacts.map((artifact) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                    key={artifact.id}
                    data-artifact-id={artifact.id}
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {taskLabels[textValue(artifact.result?.task_type)] ??
                          '任务产物'}{' '}
                        · {textValue(artifact.result?.market)} · 版本{' '}
                        {artifact.revision}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {artifact.stale
                          ? '已失效'
                          : artifact.review?.valid
                            ? '审核有效'
                            : '待人工审核'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void run(
                          async () =>
                            viewArtifact(
                              await ecomRead<EcomArtifact>(
                                workspaceId,
                                `/artifacts/${encodeURIComponent(artifact.id)}`,
                              ),
                            ),
                          '',
                        )
                      }
                      disabled={busy}
                    >
                      查看与审核
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无产物。任务完成后在这里核对证据、编辑和审核。
              </p>
            )}
          </section>
        </TabsContent>
      </Tabs>
      <Sheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
            setFallback(null);
          }
        }}
      >
        <SheetContent
          side={isMobile ? 'bottom' : 'right'}
          className="max-h-[90dvh] overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        >
          <SheetHeader>
            <SheetTitle>产物审核</SheetTitle>
            <SheetDescription>
              核对内容、证据与精确版本后再导出。
            </SheetDescription>
          </SheetHeader>
          <div className="p-4 pt-0">
            {selected && (
              <ReviewPanel
                key={selected.id}
                artifact={selected}
                workspaceId={workspaceId}
                onChange={() => void reload()}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
