import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Variables } from '../web-context.js';
import { ecommerceEnabled, ecommerceLimits } from './config.js';
import { createEcommerceWorkflow, validateBusinessResult } from './service.js';
import type { Artifact, ModelAdapter, TaskRequest } from './workflow.js';
import {
  getObject,
  listObjects,
  putObject,
  readSourceAsset,
  listSourceAssets,
  getEvidence,
  transact,
  sha256,
} from './repository.js';
import {
  createProduct,
  getProduct,
  confirmFacts,
  stageFactCandidates,
} from './facts.js';
import {
  importAssets,
  type AssetMetadata,
  type ImportMapping,
} from './ingest.js';
import {
  ingestKnowledge,
  ensureKnowledgeScope,
  type KnowledgeMetadata,
  type KnowledgeDocument,
} from './knowledge.js';
import { parseAdReport, type ReportMapping } from './reports.js';
import { hash } from './contracts.js';
import { validateQuality } from './quality.js';
import { reviewArtifact, editArtifact, exportArtifact } from './review.js';

export interface EcommerceRouteDependencies {
  auth: MiddlewareHandler<{ Variables: Variables }>;
  authorize: (workspaceId: string, ownerId: string, write: boolean) => void;
  enabled?: () => boolean;
  model?: ModelAdapter;
  maxFileBytes?: number;
  maxElapsedMs?: () => number;
  modelStatus?: (
    workspaceId: string,
  ) => 'not_configured' | 'configured_unprobed';
  followUp?: (input: {
    workspace_id: string;
    artifact: Artifact;
    criteria: string[];
    due_at: string;
    request_key: string;
    owner_id: string;
  }) => Promise<unknown>;
  refreshFollowUp?: (
    workspaceId: string,
    ownerId: string,
    goalId: string,
  ) => Promise<unknown>;
}
const object = z.record(z.string(), z.unknown());
const workspace = z.string().min(1).max(256);
const requestKey = z.string().trim().min(1).max(128);
const scope = z.object({ workspace_id: workspace });
export function createEcommerceRoutes(deps: EcommerceRouteDependencies) {
  const app = new Hono<{ Variables: Variables }>(),
    enabled = deps.enabled ?? ecommerceEnabled;
  const flow = createEcommerceWorkflow(
    deps.model,
    (ws, owner) => {
      if (!enabled()) throw new Error('FEATURE_DISABLED');
      deps.authorize(ws, owner, true);
    },
    deps.maxElapsedMs,
  );
  app.use('*', deps.auth);
  app.get('/availability', (c) =>
    c.json({ enabled: enabled(), platform_apis: 'not_configured' }),
  );
  app.use('*', async (c, next) => {
    if (!enabled()) return c.json({ error: 'Not found' }, 404);
    await next();
  });
  app.onError((error, c) => {
    const raw = (error as { code?: string }).code ?? error.message;
    const code = /^[A-Za-z0-9_]+$/.test(raw) ? raw : 'INVALID_REQUEST';
    const status = /not_found|NOT_FOUND/.test(code)
      ? 404
      : /GOAL_UNAVAILABLE|GOAL_FEATURE_DISABLED/.test(code)
        ? 503
        : /revision|REVISION|IDEMPOTENCY/.test(code)
          ? 409
          : /REVIEW_BLOCKED|APPROVAL_REQUIRED|FEATURE_DISABLED/.test(code)
            ? 403
            : 400;
    return c.json(
      {
        error: '请求未完成，请检查资料、权限或版本后重试',
        code,
        ...(error instanceof z.ZodError
          ? {
              fields: error.issues.map((v) => ({
                path: v.path,
                message: v.message,
              })),
            }
          : {}),
      },
      status,
    );
  });
  const authorize = (c: any, ws: string, write = false) => {
    deps.authorize(ws, c.get('user').id, write);
    return c.get('user').id as string;
  };
  app.get('/workspace', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    const values = (kind: string) => listObjects(ws, kind).map((r) => r.body);
    return c.json({
      products: values('product'),
      assets: listSourceAssets(ws),
      knowledge: values('knowledge'),
      tasks: values('task'),
      artifacts: values('artifact'),
      reports: values('report'),
    });
  });
  app.get('/health', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    return c.json({
      application: 'ready',
      model: deps.modelStatus?.(ws) ?? 'not_probed',
      data: listSourceAssets(ws).length ? 'imported' : 'empty',
      platform_apis: 'not_configured',
    });
  });
  app.post('/products', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        product: z
          .object({
            id: z.string().min(1).max(200).optional(),
            sku: z.string().trim().min(1).max(200),
            market: z.enum(['US', 'DE']),
            locale: z.enum(['en-US', 'de-DE']),
            product_type: z.string().min(1).max(200),
            seller_scope: z.string().min(1).max(200),
          })
          .strict(),
      })
      .strict()
      .parse(await c.req.json());
    authorize(c, body.workspace_id, true);
    return c.json(
      createProduct({
        ...body.product,
        id: body.product.id ?? randomUUID(),
        workspace_id: body.workspace_id,
        facts: [],
      }),
      201,
    );
  });
  app.post('/assets', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        name: z.string().min(1).max(240),
        format: z.string().max(20).optional(),
        content_base64: z.string().optional(),
        text: z.string().optional(),
        metadata: object,
        mapping: object.optional(),
        request_key: requestKey,
      })
      .strict()
      .parse(await c.req.json());
    authorize(c, body.workspace_id, true);
    if ((body.content_base64 === undefined) === (body.text === undefined))
      throw new Error('ONE_FILE_CONTENT_REQUIRED');
    const max = Math.min(
      deps.maxFileBytes ?? ecommerceLimits().max_file_bytes,
      ecommerceLimits().max_file_bytes,
    );
    if (
      (body.content_base64?.length ?? 0) > Math.ceil(max / 3) * 4 + 4 ||
      (body.text && Buffer.byteLength(body.text) > max)
    )
      throw new Error('FILE_TOO_LARGE');
    if (
      body.content_base64 &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        body.content_base64,
      )
    )
      throw new Error('INVALID_BASE64');
    const bytes =
      body.content_base64 !== undefined
        ? Buffer.from(body.content_base64, 'base64')
        : Buffer.from(body.text!, 'utf8');
    const digest = hash({
      name: body.name,
      bytes: sha256(bytes),
      metadata: body.metadata,
      mapping: body.mapping ?? {},
    });
    const receipt = transact(() => {
      const previous = getObject<{ digest: string; known_at: string }>(
        body.workspace_id,
        'asset_request',
        body.request_key,
      );
      if (previous) {
        if (previous.body.digest !== digest)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return previous.body;
      }
      const value = { digest, known_at: new Date().toISOString() };
      putObject(body.workspace_id, 'asset_request', body.request_key, value, 0);
      return value;
    });
    const metadata = {
      ...body.metadata,
      owner_scope: body.workspace_id,
      known_at: receipt.known_at,
    } as unknown as AssetMetadata;
    for (const ref of metadata.product_refs ?? []) {
      const p = getProduct(body.workspace_id, ref.product_id);
      if (!p || p.market !== ref.market || p.sku !== ref.sku)
        throw new Error('NOT_FOUND');
    }
    const imported = await importAssets(
      body.workspace_id,
      [{ filename: body.name, bytes, metadata }],
      (body.mapping ?? {}) as ImportMapping,
      body.request_key,
      { max_asset_bytes: max },
    );
    transact(() => {
      for (const ref of metadata.product_refs ?? []) {
        const product = getProduct(body.workspace_id, ref.product_id)!;
        const facts = imported.rows
          .filter((r) => r.sku === product.sku)
          .map((r) => r.fact);
        if (facts.length)
          stageFactCandidates(
            body.workspace_id,
            product.id,
            product.revision,
            facts,
          );
      }
    });
    return c.json(
      {
        ...imported,
        asset: imported.assets[0] ?? null,
        candidates: imported.rows.map((r) => r.fact),
        errors: imported.row_errors,
      },
      imported.row_errors.length ? 207 : 201,
    );
  });
  app.post('/products/:id/confirm', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        expected_revision: z.number().int().positive(),
        decisions: z.array(object).min(1).max(500),
        reason: z.string().min(1).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const actor = authorize(c, body.workspace_id, true);
    const decisions = body.decisions.map((v) => ({
      evidence_id: String(v.evidence_id ?? ''),
      decision: (v.decision ??
        (v.verification_state === 'rejected' ? 'reject' : 'confirm')) as
        | 'confirm'
        | 'reject',
      reason: String(v.reason ?? body.reason ?? ''),
    }));
    const product = transact(() => {
      const p = confirmFacts(
        body.workspace_id,
        c.req.param('id'),
        body.expected_revision,
        decisions,
        actor,
      );
      flow.invalidateDependents(body.workspace_id, 'product', p.id, p.revision);
      return p;
    });
    return c.json(product);
  });
  app.post('/knowledge', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        asset_id: z.string().min(1),
        metadata: object,
        expected_revision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .parse(await c.req.json());
    const actor = authorize(c, body.workspace_id, true);
    const result = transact(() => {
      const k = ingestKnowledge(
        body.workspace_id,
        body.asset_id,
        {
          ...body.metadata,
          known_at: new Date().toISOString(),
        } as unknown as KnowledgeMetadata,
        body.expected_revision ?? 0,
      );
      flow.invalidateDependents(
        body.workspace_id,
        'knowledge',
        k.id,
        k.revision,
      );
      const epoch = ensureKnowledgeScope(body.workspace_id, k);
      flow.invalidateDependents(
        body.workspace_id,
        'knowledge_scope',
        epoch.id,
        epoch.revision,
      );
      for (const old of listObjects<KnowledgeDocument>(
        body.workspace_id,
        'knowledge',
      ))
        if (
          old.id !== k.id &&
          old.body.market === k.market &&
          old.body.product_type === k.product_type &&
          old.body.seller_scope === k.seller_scope
        )
          flow.invalidateDependents(body.workspace_id, 'knowledge', old.id, -1);
      putObject(
        body.workspace_id,
        'knowledge_review',
        k.id + ':' + k.revision,
        {
          actor_id: actor,
          at: new Date().toISOString(),
          approval_state: k.approval_state,
        },
        0,
      );
      return k;
    });
    return c.json(result, 201);
  });
  app.post('/reports', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        asset_id: z.string().min(1),
        mapping: z.enum(['sp-search-term-v1', 'sp-campaign-v1']),
        metadata: object,
      })
      .strict()
      .parse(await c.req.json());
    authorize(c, body.workspace_id, true);
    const source = readSourceAsset(body.workspace_id, body.asset_id);
    if (!source) throw new Error('NOT_FOUND');
    if (source.asset.kind !== 'report')
      throw new Error('INVALID_REPORT_SOURCE');
    const parsed = parseAdReport(
      source.raw,
      body.mapping as ReportMapping,
      { ...body.metadata, workspace_id: body.workspace_id },
      source.asset.filename.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv',
    );
    if (!parsed.ok)
      return c.json(
        { code: 'REPORT_MAPPING_ERRORS', errors: parsed.errors },
        422,
      );
    const id = parsed.report.metadata.report_id,
      old = getObject(body.workspace_id, 'report', id);
    if (old && hash(old.body) !== hash(parsed.report))
      throw new Error('IDEMPOTENCY_CONFLICT');
    if (!old) putObject(body.workspace_id, 'report', id, parsed.report, 0);
    for (const row of parsed.report.rows) {
      const { putEvidence } = await import('./repository.js');
      putEvidence(body.workspace_id, {
        evidence_id: row.evidence_id,
        source_id: body.asset_id,
        kind: 'report',
        locator: 'row:' + row.source_row,
        content_hash: source.asset.content_hash,
        provenance: source.asset.provenance,
        excerpt: JSON.stringify(row),
      });
    }
    return c.json(parsed.report, 201);
  });
  app.post('/tasks', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        task_type: z.enum([
          'research_brief',
          'listing_pack',
          'ad_pack',
          'ads_diagnosis',
          'support_draft',
        ]),
        market: z.enum(['US', 'DE']),
        locale: z.enum(['en-US', 'de-DE']),
        product_ids: z.array(z.string()).max(20),
        query: z.string().max(2000).optional(),
        asset_ids: z.array(z.string()).max(20).optional(),
        report_ids: z.array(z.string()).max(20).optional(),
        support: object.optional(),
        placement: z.string().max(200).optional(),
        request_key: requestKey,
        as_of: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const actor = authorize(c, body.workspace_id, true);
    const { workspace_id, request_key, ...request } = body;
    if (request.as_of && Date.parse(request.as_of) > Date.now() + 1000)
      throw new Error('FUTURE_AS_OF');
    // Cross-scope inputs fail before any model dispatch.
    for (const id of request.product_ids) {
      const p = getProduct(workspace_id, id);
      if (!p) throw new Error('NOT_FOUND');
      if (p.market !== request.market) throw new Error('WRONG_MARKET');
    }
    for (const id of request.asset_ids ?? []) {
      const a = readSourceAsset(workspace_id, id);
      if (!a) throw new Error('NOT_FOUND');
      if (a.asset.market !== request.market) throw new Error('WRONG_MARKET');
    }
    const task = flow.startTask(
      workspace_id,
      actor,
      request as TaskRequest,
      request_key,
    );
    void flow.resumeTask(workspace_id, task.id).catch(() => {});
    return c.json(task, 202);
  });
  app.get('/tasks/:id', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    return c.json(flow.getTask(ws, c.req.param('id')));
  });
  for (const action of ['resume', 'pause', 'cancel'])
    app.post('/tasks/:id/' + action, async (c) => {
      const body = scope.strict().parse(await c.req.json());
      authorize(c, body.workspace_id, true);
      const id = z.string().min(1).parse(c.req.param('id'));
      if (action === 'resume') {
        flow.reopenWithUpdatedInputs(body.workspace_id, id);
        void flow.resumeTask(body.workspace_id, id).catch(() => {});
        return c.json(flow.getTask(body.workspace_id, id), 202);
      }
      return c.json(flow.pauseTask(body.workspace_id, id, action === 'cancel'));
    });
  app.get('/artifacts/:id', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    return c.json(flow.getArtifact(ws, c.req.param('id')));
  });
  app.patch('/artifacts/:id', async (c) => {
    const body = z
      .object({
        workspace_id: workspace,
        expected_revision: z.number().int().positive(),
        payload: object,
      })
      .strict()
      .parse(await c.req.json());
    authorize(c, body.workspace_id, true);
    const id = c.req.param('id'),
      a = flow.getArtifact(body.workspace_id, id),
      task = flow.getTask(body.workspace_id, a.task_id);
    return c.json(
      editArtifact(
        body.workspace_id,
        id,
        body.expected_revision,
        body.payload,
        (result) => [
          ...validateQuality(result, {
            products: task.snapshot?.products ?? [],
            evidence: task.snapshot?.evidence ?? [],
            rules: task.snapshot?.rules ?? [],
          }),
          ...(task.snapshot
            ? validateBusinessResult(
                result,
                task.snapshot,
                body.workspace_id,
                task.id,
              )
            : [
                {
                  code: 'CONTEXT_MISSING',
                  severity: 'blocking' as const,
                  message: '冻结上下文缺失',
                  field: null,
                },
              ]),
        ],
      ),
    );
  });
  app.post('/artifacts/:id/review', async (c) => {
    const b = z
      .object({
        workspace_id: workspace,
        expected_revision: z.number().int().positive(),
        content_hash: z.string().length(64),
        decision: z.enum(['approve', 'reject']),
        reason: z.string().trim().min(1).max(2000),
        request_key: requestKey,
      })
      .strict()
      .parse(await c.req.json());
    const user = authorize(c, b.workspace_id, true);
    return c.json(
      reviewArtifact(
        b.workspace_id,
        c.req.param('id'),
        b.expected_revision,
        b.content_hash,
        b.decision,
        b.reason,
        user,
        b.request_key,
      ),
    );
  });
  app.get('/artifacts/:id/export', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    const a = flow.getArtifact(ws, c.req.param('id'));
    const revision =
      c.req.query('revision') === undefined
        ? a.revision
        : Number(c.req.query('revision'));
    const out = exportArtifact(
      ws,
      a.id,
      revision,
      z.enum(['json', 'markdown', 'csv']).parse(c.req.query('format')),
      z.enum(['preview', 'approved']).parse(c.req.query('mode')),
    );
    return c.body(out.content, 200, {
      'Content-Type': out.mime,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'no-store',
    });
  });
  app.get('/assets/:id/content', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    const source = readSourceAsset(
      ws,
      c.req.param('id'),
      c.req.query('version'),
    );
    if (!source) throw new Error('NOT_FOUND');
    return c.body(new Uint8Array(source.raw), 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="ecommerce-source.bin"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get('/evidence/:id', (c) => {
    const ws = workspace.parse(c.req.query('workspace_id'));
    authorize(c, ws);
    const ev = getEvidence(ws, c.req.param('id'));
    if (!ev) throw new Error('NOT_FOUND');
    return c.json(ev);
  });
  app.post('/artifacts/:id/follow-up', async (c) => {
    const b = z
      .object({
        workspace_id: workspace,
        expected_revision: z.number().int().positive(),
        criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
        due_at: z.string().datetime({ offset: true }),
        request_key: requestKey,
      })
      .strict()
      .parse(await c.req.json());
    const actor = authorize(c, b.workspace_id, true),
      artifact = flow.getArtifact(b.workspace_id, c.req.param('id'));
    if (artifact.revision !== b.expected_revision)
      throw new Error('REVISION_CONFLICT');
    if (!deps.followUp) throw new Error('GOAL_UNAVAILABLE');
    return c.json(
      await deps.followUp({ ...b, artifact, owner_id: actor }),
      201,
    );
  });
  app.post('/follow-ups/:id/refresh', async (c) => {
    const b = scope.strict().parse(await c.req.json()),
      owner = authorize(c, b.workspace_id, true);
    if (!deps.refreshFollowUp) throw new Error('GOAL_UNAVAILABLE');
    return c.json(
      await deps.refreshFollowUp(b.workspace_id, owner, c.req.param('id')),
    );
  });
  return app;
}
