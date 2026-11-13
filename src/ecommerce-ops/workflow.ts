import { randomUUID } from 'node:crypto';
import {
  emptyUsage,
  failureResult,
  hash,
  issue,
  validateTaskResult,
} from './contracts.js';
import { getObject, putObject, transact, listObjects } from './repository.js';
import { validateQuality } from './quality.js';
import { ecommerceLimits } from './config.js';
import type {
  BoundTaskContext,
  TaskResult,
  Issue,
  Usage,
} from './contracts.js';
import type { Product, Evidence, Market, Locale, TaskType } from './domain.js';
import type { RuleProfile } from './quality.js';
export interface TaskRequest {
  task_type: TaskType;
  market: Market;
  locale: Locale;
  product_ids: string[];
  query?: string;
  asset_ids?: string[];
  report_ids?: string[];
  support?: Record<string, unknown>;
  placement?: string;
  as_of?: string;
}
export interface FrozenInputs {
  bound: BoundTaskContext;
  products: Product[];
  evidence: Evidence[];
  rules: RuleProfile[];
  dependencies: Array<{ kind: string; id: string; revision: number }>;
  issues: Issue[];
  data: Record<string, unknown>;
}
export interface WorkflowTask {
  id: string;
  workspace_id: string;
  request: TaskRequest;
  request_digest: string;
  status: string;
  phase: string;
  owner_id: string;
  input_revision: string | null;
  artifact_id: string | null;
  error: string | null;
  usage: Usage;
  created_at: string;
  updated_at: string;
  snapshot: FrozenInputs | null;
  generations: number;
  lease_owner: string | null;
  lease_until: number;
  revision: number;
}
export interface Artifact {
  id: string;
  task_id: string;
  workspace_id: string;
  revision: number;
  content_hash: string;
  input_revision: string;
  policy_snapshot_id: string | null;
  result: TaskResult;
  stale: boolean;
  quality: Issue[];
  dependencies: FrozenInputs['dependencies'];
  review: Review | null;
  created_at: string;
  updated_at: string;
}
export interface Review {
  decision: 'approve' | 'reject';
  reviewer: string;
  reason: string;
  revision: number;
  content_hash: string;
  valid: boolean;
  request_key: string;
  created_at: string;
}
export interface GenerationInput {
  task: WorkflowTask;
  snapshot: FrozenInputs;
  signal: AbortSignal;
  variant?: 'A' | 'B';
  repair?: string[];
}
export type ModelAdapter = (
  input: GenerationInput,
) => Promise<{ text: string; usage: Usage }>;
export interface WorkflowDependencies {
  freeze: (task: WorkflowTask) => FrozenInputs;
  model: ModelAdapter;
  authorize?: (workspaceId: string, ownerId: string) => void;
  fault?: (phase: string) => void;
  maxElapsedMs?: () => number;
}

export class EcommerceWorkflow {
  readonly owner = randomUUID();
  private running = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  constructor(readonly deps: WorkflowDependencies) {}
  startTask(
    workspaceId: string,
    ownerId: string,
    request: TaskRequest,
    requestKey: string,
  ): WorkflowTask {
    if (!requestKey.trim() || requestKey.length > 128)
      throw new Error('INVALID_REQUEST_KEY');
    if (
      ![
        'research_brief',
        'listing_pack',
        'ad_pack',
        'ads_diagnosis',
        'support_draft',
      ].includes(request.task_type) ||
      !['US', 'DE'].includes(request.market) ||
      request.locale !== (request.market === 'US' ? 'en-US' : 'de-DE') ||
      !Array.isArray(request.product_ids)
    )
      throw new Error('INVALID_TASK_SCOPE');
    if (
      ['listing_pack', 'ad_pack', 'support_draft'].includes(
        request.task_type,
      ) &&
      request.product_ids.length !== 1
    )
      throw new Error('SINGLE_PRODUCT_REQUIRED');
    this.deps.authorize?.(workspaceId, ownerId);
    const id = 'ect-' + hash([workspaceId, requestKey]).slice(0, 32),
      digest = hash(request);
    return transact(() => {
      const old = getObject<WorkflowTask>(workspaceId, 'task', id);
      if (old) {
        if (old.body.request_digest !== digest)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return { ...old.body, revision: old.revision };
      }
      const now = new Date().toISOString();
      const task: WorkflowTask = {
        id,
        workspace_id: workspaceId,
        owner_id: ownerId,
        request,
        request_digest: digest,
        status: 'queued',
        phase: 'freeze',
        input_revision: null,
        artifact_id: null,
        error: null,
        usage: emptyUsage(),
        created_at: now,
        updated_at: now,
        snapshot: null,
        generations: 0,
        lease_owner: null,
        lease_until: 0,
        revision: 1,
      };
      putObject(workspaceId, 'task', id, task, 0);
      return task;
    });
  }
  getTask(
    workspaceId: string,
    id: string,
  ): WorkflowTask & { artifact: Artifact | null } {
    const row = getObject<WorkflowTask>(workspaceId, 'task', id);
    if (!row) throw new Error('NOT_FOUND');
    return {
      ...row.body,
      revision: row.revision,
      artifact: row.body.artifact_id
        ? this.getArtifact(workspaceId, row.body.artifact_id)
        : null,
    };
  }
  getArtifact(workspaceId: string, id: string): Artifact {
    const row = getObject<Artifact>(workspaceId, 'artifact', id);
    if (!row) throw new Error('NOT_FOUND');
    const stale =
      row.body.stale ||
      row.body.dependencies.some(
        (d) => getObject(workspaceId, d.kind, d.id)?.revision !== d.revision,
      );
    return {
      ...row.body,
      stale,
      review: row.body.review
        ? { ...row.body.review, valid: row.body.review.valid && !stale }
        : null,
    };
  }
  private save(task: WorkflowTask, expected = task.revision): WorkflowTask {
    const body = {
      ...task,
      revision: expected + 1,
      updated_at: new Date().toISOString(),
    };
    // getTask attaches a read DTO; it must not be copied into persisted task history.
    delete (body as WorkflowTask & { artifact?: unknown }).artifact;
    const row = putObject(task.workspace_id, 'task', task.id, body, expected);
    return { ...body, revision: row.revision };
  }
  pauseTask(workspaceId: string, id: string, cancel = false): WorkflowTask {
    const updated = transact(() => {
      const task = this.getTask(workspaceId, id);
      return this.save({
        ...task,
        status: cancel ? 'cancelled' : 'paused',
        lease_owner: null,
        lease_until: 0,
      });
    });
    // The scope check and durable state transition must succeed before an
    // in-memory side effect can interrupt this task's model request.
    this.aborts.get(id)?.abort();
    return updated;
  }
  resumeTask(workspaceId: string, id: string): Promise<void> {
    const current = this.running.get(id);
    if (current) return current;
    const promise = this.execute(workspaceId, id).finally(() => {
      this.running.delete(id);
      this.aborts.delete(id);
    });
    this.running.set(id, promise);
    return promise;
  }
  reopenWithUpdatedInputs(workspaceId: string, id: string): WorkflowTask {
    return transact(() => {
      const task = this.getTask(workspaceId, id);
      if (
        !task.snapshot ||
        task.status === 'cancelled' ||
        (task.lease_owner && task.lease_until > Date.now())
      )
        return task;
      const refreshed = {
        ...task,
        request: { ...task.request, as_of: new Date().toISOString() },
      };
      const next = this.deps.freeze(refreshed),
        previous = task.snapshot;
      const signature = (s: FrozenInputs) => {
        const data = { ...s.data };
        if (data.support && typeof data.support === 'object') {
          const { as_of, ...rest } = data.support as Record<string, unknown>;
          data.support = rest;
        }
        return hash({
          products: s.products,
          evidence: s.evidence,
          rules: s.rules,
          dependencies: s.dependencies,
          issues: s.issues,
          data,
        });
      };
      if (previous && signature(previous) === signature(next)) return task;
      const attemptId = task.id + ':' + task.input_revision;
      if (!getObject(workspaceId, 'task_attempt', attemptId))
        putObject(workspaceId, 'task_attempt', attemptId, task, 0);
      return this.save({
        ...refreshed,
        snapshot: next,
        input_revision: next.bound.input_revision,
        artifact_id: null,
        generations: 0,
        status: 'queued',
        phase: 'retrieve',
        error: null,
        lease_owner: null,
        lease_until: 0,
      });
    });
  }
  private async execute(workspaceId: string, id: string): Promise<void> {
    let task: WorkflowTask = this.getTask(workspaceId, id);
    if (task.artifact_id || task.status === 'cancelled') return;
    this.deps.authorize?.(workspaceId, task.owner_id);
    const limits = ecommerceLimits(),
      controller = new AbortController();
    this.aborts.set(id, controller);
    const started = Date.now();
    const deadline = Math.min(
      limits.max_elapsed_ms,
      this.deps.maxElapsedMs?.() ?? limits.max_elapsed_ms,
    );
    const timer = setTimeout(
      () => controller.abort(new Error('BUDGET_EXHAUSTED')),
      Math.max(1, deadline),
    );
    try {
      const claimed = transact(() => {
        const fresh = this.getTask(workspaceId, id);
        if (
          fresh.lease_owner &&
          fresh.lease_owner !== this.owner &&
          fresh.lease_until > Date.now()
        )
          return null;
        return this.save({
          ...fresh,
          status: 'freezing',
          lease_owner: this.owner,
          lease_until: Date.now() + limits.max_elapsed_ms + 60000,
        });
      });
      if (!claimed) return;
      task = claimed;
      if (!task.snapshot) {
        const snapshot = this.deps.freeze(task);
        task = this.save({
          ...task,
          snapshot,
          input_revision: snapshot.bound.input_revision,
          phase: 'retrieve',
          status: 'retrieving',
        });
        this.deps.fault?.('after_freeze');
      }
      const snapshot = task.snapshot!;
      let result: TaskResult | undefined;
      if (snapshot.issues.some((i) => i.severity === 'blocking'))
        result = failureResult(
          snapshot.bound,
          'needs_input',
          snapshot.issues,
          snapshot.evidence,
          task.usage,
        );
      let repairs: string[] | undefined;
      const generationId = id + ':' + snapshot.bound.input_revision;
      const cached = getObject<{ result: TaskResult }>(
        workspaceId,
        'generation',
        generationId,
      );
      if (cached) result = cached.body.result;
      while (!result && task.generations < limits.max_generations) {
        if (controller.signal.aborted) throw new Error('CANCELLED');
        this.deps.authorize?.(workspaceId, task.owner_id);
        task = this.save({
          ...task,
          status: 'generating',
          phase: 'generate',
          generations: task.generations + 1,
        });
        try {
          let abortListener: () => void = () => {};
          const aborted = new Promise<never>((_resolve, reject) => {
            abortListener = () =>
              reject(controller.signal.reason ?? new Error('CANCELLED'));
            controller.signal.addEventListener('abort', abortListener, {
              once: true,
            });
          });
          let generated: Awaited<ReturnType<ModelAdapter>>;
          try {
            generated = await Promise.race([
              this.deps.model({
                task,
                snapshot,
                signal: controller.signal,
                repair: repairs,
              }),
              aborted,
            ]);
          } finally {
            controller.signal.removeEventListener('abort', abortListener);
          }
          const fresh = this.getTask(workspaceId, id);
          if (fresh.status === 'paused' || fresh.status === 'cancelled') return;
          task = {
            ...fresh,
            usage: { ...generated.usage, retry_count: task.generations - 1 },
          };
          task = this.save(task);
          let value: unknown;
          try {
            value = JSON.parse(
              generated.text
                .replace(/^```(?:json)?\s*/, '')
                .replace(/\s*```$/, ''),
            );
          } catch {
            repairs = ['INVALID_JSON'];
            continue;
          }
          const checked = validateTaskResult(value, snapshot.bound);
          if (!checked.ok) {
            repairs = checked.errors;
            continue;
          }
          result = { ...checked.result, usage: task.usage };
        } catch (error) {
          if (controller.signal.aborted)
            throw controller.signal.reason ?? new Error('CANCELLED');
          const message = error instanceof Error ? error.message : '';
          const code = [
            'BUDGET_EXHAUSTED',
            'CONTEXT_BUDGET_EXHAUSTED',
            'OWNER_UNAVAILABLE',
            'MODEL_OUTPUT_LIMIT',
            'MODEL_THINKING_ONLY',
            'MODEL_EMPTY_OUTPUT',
            'MODEL_TOOL_OUTPUT',
            'MODEL_INCOMPLETE_OUTPUT',
          ].includes(message)
            ? message
            : 'MODEL_UNAVAILABLE';
          const failedUsage = (error as { usage?: Usage }).usage;
          if (failedUsage) {
            task = this.save({
              ...this.getTask(workspaceId, id),
              usage: failedUsage,
            });
          }
          result = failureResult(
            snapshot.bound,
            'failed',
            [
              issue(
                code,
                '模型调用失败或预算不足；请检查配置、额度与脱敏错误码',
              ),
            ],
            snapshot.evidence,
            task.usage,
          );
        }
      }
      result ??= failureResult(
        snapshot.bound,
        'failed',
        [
          issue(
            'INVALID_MODEL_OUTPUT',
            '模型输出未通过契约校验；已达到修复次数上限',
          ),
        ],
        snapshot.evidence,
        task.usage,
      );
      // The response checkpoint is durable before later validation/commit. Recovery never regenerates it.
      transact(() => {
        if (!getObject(workspaceId, 'generation', generationId))
          putObject(workspaceId, 'generation', generationId, { result }, 0);
        task = this.save({ ...task, status: 'quality', phase: 'quality' });
      });
      this.deps.fault?.('after_generation');
      const quality = validateQuality(result, {
        products: snapshot.products,
        evidence: snapshot.evidence,
        rules: snapshot.rules,
      });
      const artifactId =
        'eca-' + hash([id, snapshot.bound.input_revision]).slice(0, 32);
      transact(() => {
        const current = this.getTask(workspaceId, id);
        if (
          current.status === 'cancelled' ||
          current.status === 'paused' ||
          current.lease_owner !== this.owner
        )
          return;
        const stale = snapshot.dependencies.some(
          (d) => getObject(workspaceId, d.kind, d.id)?.revision !== d.revision,
        );
        if (stale)
          quality.push(
            issue('STALE_INPUT', '生成期间输入版本已改变，需要重新生成'),
          );
        const artifact: Artifact = {
          id: artifactId,
          task_id: id,
          workspace_id: workspaceId,
          revision: 1,
          content_hash: hash(result),
          input_revision: snapshot.bound.input_revision,
          policy_snapshot_id: snapshot.bound.policy_snapshot_id,
          result,
          stale,
          quality,
          dependencies: snapshot.dependencies,
          review: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!getObject(workspaceId, 'artifact', artifactId))
          putObject(workspaceId, 'artifact', artifactId, artifact, 0);
        this.deps.fault?.('inside_artifact_commit');
        task = this.save({
          ...current,
          artifact_id: artifactId,
          status:
            result!.status === 'draft'
              ? quality.some((i) => i.severity === 'blocking')
                ? 'blocked'
                : 'waiting_review'
              : result!.status,
          phase: 'review',
          error: null,
          lease_owner: null,
          lease_until: 0,
        });
      });
    } catch (error) {
      transact(() => {
        const fresh = this.getTask(workspaceId, id);
        if (
          fresh.artifact_id ||
          fresh.status === 'cancelled' ||
          fresh.status === 'paused'
        )
          return;
        const code =
          error instanceof Error &&
          ['CANCELLED', 'BUDGET_EXHAUSTED'].includes(error.message)
            ? error.message
            : 'INTERRUPTED';
        this.save({
          ...fresh,
          status: 'failed',
          error: code,
          lease_owner: null,
          lease_until: 0,
        });
      });
    } finally {
      clearTimeout(timer);
      void started;
    }
  }
  invalidateDependents(
    workspaceId: string,
    kind: string,
    id: string,
    revision: number,
  ): string[] {
    return transact(() => {
      const changed: string[] = [];
      for (const row of listObjects<Artifact>(workspaceId, 'artifact')) {
        if (
          !row.body.dependencies.some(
            (d) => d.kind === kind && d.id === id && d.revision !== revision,
          ) ||
          row.body.stale
        )
          continue;
        const body = {
          ...row.body,
          stale: true,
          review: row.body.review ? { ...row.body.review, valid: false } : null,
          updated_at: new Date().toISOString(),
        };
        putObject(workspaceId, 'artifact', row.id, body, row.revision);
        changed.push(row.id);
      }
      return changed;
    });
  }
}
