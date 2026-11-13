import type { Evidence, EvidenceScope } from './domain.js';
import type { WorkflowTask, FrozenInputs, ModelAdapter } from './workflow.js';
import { EcommerceWorkflow } from './workflow.js';
import { hash, issue, type Issue, type TaskResult } from './contracts.js';
import { freezeInputs, getProduct } from './facts.js';
import {
  retrieveEvidence,
  resolvePolicy,
  ensureKnowledgeScope,
  type RetrievedEvidenceBundle,
} from './knowledge.js';
import {
  getObject,
  putObject,
  getEvidence,
  putEvidence,
  readSourceAsset,
  transact,
} from './repository.js';
import type { RuleProfile } from './quality.js';
import { validateReportScope, type NormalizedAdReport } from './reports.js';
import { computeAdMetrics } from './metrics.js';
import {
  prepareSupportContext,
  validateSupportDraft,
  type SupportInput,
  type SupportDraftPayload,
} from './tasks/support.js';
import { approvedOrderContext } from './tasks/order-context.js';
import { configuredModel } from './model.js';

/** The same frozen-input function is used by product execution and replay. */
export function freezeTask(task: WorkflowTask): FrozenInputs {
  const request = task.request,
    asOf = request.as_of ?? task.created_at,
    ws = task.workspace_id;
  const products = request.product_ids.map((id) => {
    const p = getProduct(ws, id);
    if (!p) throw new Error('NOT_FOUND');
    if (p.market !== request.market || p.locale !== request.locale)
      throw new Error('WRONG_MARKET');
    return p;
  });
  const problems: Issue[] = [];
  let confirmed: Evidence[] = [];
  if (
    !products.length &&
    request.task_type !== 'ads_diagnosis' &&
    !(request.task_type === 'research_brief' && request.asset_ids?.length)
  )
    problems.push(
      issue('PRODUCT_REQUIRED', '请先导入并确认目标SKU或提供候选资料'),
    );
  if (products.length) {
    try {
      confirmed = freezeInputs({
        workspace_id: ws,
        product_ids: request.product_ids,
        market: request.market,
        locale: request.locale,
        as_of: asOf,
      }).evidence;
    } catch (error) {
      problems.push(
        issue(
          (error as { code?: string }).code ?? 'FACT_CONFLICT',
          '产品事实冲突或证据不完整，请核验资料后重试',
        ),
      );
    }
    if (
      request.task_type !== 'research_brief' &&
      products.some(
        (p) =>
          !p.facts.some(
            (f) => f.verification_state === 'confirmed' && f.value !== null,
          ),
      )
    )
      problems.push(issue('FACTS_REQUIRED', '尚无已确认且有证据的产品事实'));
  }
  const bundles: RetrievedEvidenceBundle[] = [],
    rules: RuleProfile[] = [];
  for (const product of products) {
    const scope: EvidenceScope = {
      workspace_id: ws,
      market: request.market,
      locale: request.locale,
      product_type: product.product_type,
      seller_scope: product.seller_scope,
      product_refs: [
        {
          product_id: product.id,
          sku: product.sku,
          revision: String(product.revision),
          market: product.market,
        },
      ],
      as_of: asOf,
      known_as_of: asOf,
    };
    bundles.push(
      retrieveEvidence(
        request.query ?? `${request.task_type} product policy rules`,
        scope,
        5,
      ),
    );
  }
  const policyRefs: Array<{ id: string; revision: number; version: string }> =
    [];
  const selectedPolicyEvidence: Evidence[] = [];
  for (const b of bundles) {
    const resolution = resolvePolicy(b, b.scope);
    policyRefs.push(...resolution.document_refs);
    if (resolution.status === 'conflict')
      problems.push(
        issue('POLICY_CONFLICT', '存在重叠有效且冲突的规则版本，请人工裁决'),
      );
    if (resolution.status === 'unknown' && request.task_type === 'listing_pack')
      problems.push(
        issue(
          'POLICY_UNKNOWN',
          '缺少该SKU/站点已审核且适用的规则，不能审核完整上新成果',
        ),
      );
    for (const doc of b.policy_documents.filter((d) =>
      resolution.document_refs.some(
        (ref) => ref.id === d.id && ref.revision === d.revision,
      ),
    )) {
      selectedPolicyEvidence.push(...doc.chunks);
      const source = readSourceAsset(ws, doc.asset_id, doc.asset_version);
      if (!source) throw new Error('EVIDENCE_MISSING');
      try {
        const parsed = JSON.parse(source.text);
        const profile = parsed[request.task_type] ?? parsed.profile;
        if (
          profile &&
          typeof profile === 'object' &&
          !Array.isArray(profile) &&
          !(
            request.task_type === 'ad_pack' &&
            profile.placement &&
            profile.placement !== (request.placement ?? 'internal_draft')
          )
        )
          rules.push({ ...profile, version: doc.version });
      } catch {
        /* Narrative policy remains quoted evidence, with partial coverage. */
      }
    }
  }
  const selectedEvidenceIds = new Set(
    selectedPolicyEvidence.map((e) => e.evidence_id),
  );
  for (const profile of rules)
    for (const field of profile.required_facts ?? [])
      if (
        products.some(
          (product) =>
            !product.facts.some(
              (fact) =>
                fact.field === field &&
                fact.verification_state === 'confirmed' &&
                fact.value !== null &&
                fact.value !== '',
            ),
        )
      )
        problems.push(
          issue(
            'UNKNOWN_REQUIRED_FACT',
            `适用规则要求的产品事实尚未确认：${field}`,
            '/facts/' + field,
          ),
        );
  const evidence = [
    ...new Map(
      [
        ...confirmed,
        ...bundles
          .flatMap((b) => b.evidence)
          .filter(
            (e) =>
              e.kind !== 'order' &&
              e.kind !== 'ticket' &&
              (e.kind !== 'policy' || selectedEvidenceIds.has(e.evidence_id)),
          ),
        ...selectedPolicyEvidence,
      ].map((e) => [e.evidence_id, e]),
    ).values(),
  ];
  const data: Record<string, unknown> = {
    query: request.query ?? '',
    placement: request.placement ?? 'internal_draft',
    retrieval: bundles.map((b) => ({
      query: b.query,
      retrieved_doc_refs: b.retrieved_doc_refs,
      filtered: b.filtered,
    })),
    rule_coverage: 'partial',
  };
  const dependencies: FrozenInputs['dependencies'] = [
    ...products.map((p) => ({
      kind: 'product',
      id: p.id,
      revision: getObject(ws, 'product', p.id)!.revision,
    })),
    ...policyRefs.map((p) => ({
      kind: 'knowledge',
      id: p.id,
      revision: p.revision,
    })),
  ];
  for (const product of products) {
    const epoch = ensureKnowledgeScope(ws, {
      market: product.market,
      product_type: product.product_type,
      seller_scope: product.seller_scope,
    });
    if (
      !dependencies.some(
        (d) => d.kind === 'knowledge_scope' && d.id === epoch.id,
      )
    )
      dependencies.push({
        kind: 'knowledge_scope',
        id: epoch.id,
        revision: epoch.revision,
      });
  }
  for (const id of request.asset_ids ?? []) {
    const source = readSourceAsset(ws, id);
    if (!source) throw new Error('NOT_FOUND');
    if (source.asset.market !== request.market) throw new Error('WRONG_MARKET');
    if (
      Date.parse(source.asset.known_at) > Date.parse(asOf) ||
      Date.parse(source.asset.observed_at) > Date.parse(asOf)
    ) {
      problems.push(
        issue('NOT_YET_KNOWN', '附件在本次 as_of 之后才可见，不进入上下文', id),
      );
      continue;
    }
    // Arbitrary ticket/order bodies are never passed directly to the model.
    if (
      request.task_type === 'research_brief' &&
      source.asset.kind === 'competitor'
    ) {
      const excerpt = source.text.slice(0, 12000),
        ref = 'ev-candidate-' + hash([id, source.asset.version, excerpt]);
      const ev: Evidence = {
        evidence_id: ref,
        source_id: id,
        kind: 'competitor',
        locator: `version:${source.asset.version};chars:0-${excerpt.length}`,
        content_hash: source.asset.content_hash,
        provenance: source.asset.provenance,
        excerpt,
      };
      putEvidence(ws, ev);
      evidence.push(ev);
      data.candidates = [
        ...((data.candidates as unknown[]) ?? []),
        {
          source_id: id,
          text: excerpt,
          evidence_id: ref,
          provenance: source.asset.provenance,
        },
      ];
      if (source.text.length > excerpt.length)
        problems.push(
          issue(
            'CANDIDATE_TRUNCATED',
            '候选材料较长，本次仅使用明确标注的节选',
            id,
            'warning',
          ),
        );
    }
  }
  if (request.task_type === 'ads_diagnosis') {
    const reports = (request.report_ids ?? []).map((id) => {
      const r = getObject<NormalizedAdReport>(ws, 'report', id);
      if (!r) throw new Error('NOT_FOUND');
      if (r.body.metadata.market !== request.market)
        throw new Error('WRONG_MARKET');
      dependencies.push({ kind: 'report', id, revision: r.revision });
      return r.body;
    });
    const comparable = validateReportScope(reports, { asOf });
    if (!comparable.ok || !comparable.rows || !comparable.scope)
      problems.push(
        ...comparable.reasons.map((r) =>
          issue('REPORT_INCOMPARABLE', r.message, r.field),
        ),
      );
    else {
      const computed = computeAdMetrics(comparable.rows, {
        ...comparable.scope,
        as_of: asOf,
      });
      data.metrics = computed.metrics;
      data.maturity = computed.maturity;
      data.null_reasons = computed.null_reasons;
      data.limitations = computed.limitations;
      data.report_id = reports.map((r) => r.metadata.report_id).join(',');
      data.metrics_ref =
        'metrics-' + hash([reports.map((r) => r.content_hash), asOf]);
      for (const row of comparable.rows) {
        const ev = getEvidence(ws, row.evidence_id);
        if (ev) evidence.push(ev);
      }
    }
  }
  if (request.task_type === 'support_draft') {
    const raw = request.support ?? {},
      ticket = (raw.ticket ?? {}) as Record<string, unknown>;
    const merchant = bundles
      .flatMap((b) => b.policy_documents)
      .find((p) => p.authority === 'merchant');
    const policy = merchant
      ? {
          workspace_id: ws,
          market: request.market,
          approved: merchant.approval_state === 'approved',
          effective_from: merchant.effective_from!,
          effective_to: merchant.effective_to,
          known_at: merchant.known_at,
          evidence_refs: merchant.chunks.map((e) => e.evidence_id),
        }
      : undefined;
    if (typeof ticket.text !== 'string' || !ticket.text.trim())
      problems.push(issue('TICKET_REQUIRED', '请导入脱敏工单文本'));
    else {
      const sourceTicketId =
        typeof ticket.ticket_id === 'string'
          ? ticket.ticket_id
          : 'ticket-' + task.id;
      const ticketId = 'ticket-' + hash([ws, sourceTicketId]);
      let order: SupportInput['order'];
      const orders = [
        ...new Map(
          bundles
            .flatMap((b) => b.applicable_documents ?? [])
            .filter(
              (d) =>
                d.kind === 'order' &&
                d.product_refs.some((ref) =>
                  products.some(
                    (p) => ref.product_id === p.id && ref.sku === p.sku,
                  ),
                ) &&
                request.asset_ids?.includes(d.asset_id),
            )
            .map((d) => [d.id, d]),
        ).values(),
      ];
      if (orders.length === 1) {
        const doc = orders[0],
          source = readSourceAsset(ws, doc.asset_id, doc.asset_version);
        if (source) {
          try {
            const approved = approvedOrderContext({
              raw: JSON.parse(source.text),
              asset: source.asset,
              approved: doc.approval_state === 'approved',
              ticket_id: sourceTicketId,
              workspace_id: ws,
              market: request.market,
            });
            order = approved.order;
            for (const ev of approved.evidence) {
              putEvidence(ws, ev);
              evidence.push(ev);
            }
            dependencies.push({
              kind: 'knowledge',
              id: doc.id,
              revision: doc.revision,
            });
            data.order_origin = 'human_reviewed_import';
          } catch {
            problems.push(
              issue(
                'ORDER_IMPORT_INVALID',
                '已导入订单的范围/字段不适用，请人工更新',
                'order',
                'warning',
              ),
            );
          }
        }
      } else if (orders.length > 1)
        problems.push(
          issue(
            'ORDER_IMPORT_CONFLICT',
            '多个订单材料均适用，请明确选择本工单的一个订单来源',
            'order',
            'warning',
          ),
        );
      const input: SupportInput = {
        workspace_id: ws,
        market: request.market,
        locale: request.locale,
        as_of: asOf,
        ticket: {
          ticket_id: ticketId,
          workspace_id: ws,
          text: ticket.text,
          pii: ticket.pii as SupportInput['ticket']['pii'],
        },
        policy,
        order,
      };
      // Request bodies cannot self-assert a verified order. Only reviewed, scoped source revisions can support it.
      const prepared = prepareSupportContext(input);
      data.support = prepared.model_context;
      data.support_gate = {
        action: prepared.action,
        missing_information: prepared.missing_information,
      };
      // Guards stay server side; only model_context is sent to the model adapter.
      putObject(ws, 'support_guard', task.id, prepared);
      problems.push(
        ...prepared.issues.map((p) => ({ ...p, severity: 'warning' as const })),
      );
    }
  }
  const product_refs = products.map((p) => ({
    product_id: p.id,
    sku: p.sku,
    revision: String(p.revision),
    market: p.market,
  }));
  const policy_snapshot_id = policyRefs.length
    ? 'policy-' + hash(policyRefs)
    : null;
  const input_revision = hash({
    request,
    products,
    evidence,
    policyRefs,
    data,
    dependencies,
  });
  return {
    bound: {
      task_id: task.id,
      task_type: request.task_type,
      workspace_id: ws,
      market: request.market,
      locale: request.locale,
      as_of: asOf,
      product_refs,
      input_revision,
      policy_snapshot_id,
    },
    products,
    evidence: [...new Map(evidence.map((e) => [e.evidence_id, e])).values()],
    rules,
    dependencies,
    issues: problems,
    data,
  };
}

/** Reused for model generation, human edits and the review API. */
export function validateBusinessResult(
  parsed: TaskResult,
  snapshot: FrozenInputs,
  workspaceId: string,
  taskId: string,
): Issue[] {
  if (parsed.status !== 'draft' || !parsed.payload) return [];
  const issues: Issue[] = [];
  if (parsed.task_type === 'ad_pack') {
    const placement = snapshot.data.placement;
    if (parsed.payload.placement !== placement)
      issues.push(
        issue('PLACEMENT_MISMATCH', '文案格式与本任务选择的placement不一致'),
      );
    const hasProfile = snapshot.rules.some(
      (rule) => rule.placement === placement,
    );
    if (
      !hasProfile &&
      (parsed.payload.rule_coverage !== 'internal_draft' ||
        !Array.isArray(parsed.payload.unchecked_rules) ||
        !parsed.payload.unchecked_rules.length)
    )
      issues.push(
        issue(
          'PLACEMENT_PROFILE_MISSING',
          '缺少适用placement规则，只能保留明确标注未检查项的内部草稿',
        ),
      );
  }
  if (parsed.task_type === 'ads_diagnosis') {
    if (
      hash(parsed.payload.metrics) !== hash(snapshot.data.metrics) ||
      parsed.payload.maturity !== snapshot.data.maturity ||
      parsed.payload.metrics_ref !== snapshot.data.metrics_ref ||
      parsed.payload.report_id !== snapshot.data.report_id
    )
      issues.push(issue('METRICS_MISMATCH', '输出改变了代码计算结果/口径引用'));
    if (
      snapshot.data.maturity !== 'complete' &&
      hasPrematureAdsAction(parsed.payload.findings)
    )
      issues.push(
        issue('ATTRIBUTION_INCOMPLETE', '归因未成熟，不能据此否词或停投'),
      );
  }
  if (parsed.task_type === 'support_draft') {
    const guard = getObject<ReturnType<typeof prepareSupportContext>>(
      workspaceId,
      'support_guard',
      taskId,
    )?.body;
    if (!guard)
      issues.push(issue('SUPPORT_GUARD_MISSING', '客服校验上下文缺失'));
    else
      issues.push(
        ...validateSupportDraft(
          parsed.payload as unknown as SupportDraftPayload,
          guard,
        ),
      );
  }
  return issues;
}
function hasPrematureAdsAction(findings: unknown): boolean {
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => {
    if (!finding || typeof finding !== 'object') return false;
    return ['message', 'action_draft'].some((key) => {
      const value = (finding as Record<string, unknown>)[key];
      if (typeof value !== 'string') return false;
      return value.split(/[.!?;。；！\n]/).some((sentence) => {
        if (!/negativ|pause|stop|否词|停投|ausschließ|pausier/i.test(sentence))
          return false;
        // Only explicit prohibitions are exempt; a contrasting instruction is still reviewed.
        if (
          !/\b(?:but|however|instead|aber|sondern|dennoch)\b|但是|但应|反而/i.test(
            sentence,
          ) &&
          (/\b(?:do not|don't|never|must not|should not)\s+(?:recommend|suggest|advise|add|use|apply|set|pause|stop|exclude|negate)\b/i.test(
            sentence,
          ) ||
            /(?:不建议|不要|不得|不能|不应|不可).*(?:否词|停投)/.test(
              sentence,
            ) ||
            /\b(?:keine?|nicht)\b.*(?:negativ|ausschließ|pausier|stop)/i.test(
              sentence,
            ))
        )
          return false;
        return true;
      });
    });
  });
}
/** Enforce code-owned metrics and support gates on every model completion. */
export function guardedModel(model: ModelAdapter): ModelAdapter {
  return async (input) => {
    const response = await model(input);
    let parsed: TaskResult;
    try {
      parsed = JSON.parse(
        response.text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''),
      );
    } catch {
      return response;
    }
    if (parsed.status === 'draft' && parsed.payload) {
      const issues = validateBusinessResult(
        parsed,
        input.snapshot,
        input.task.workspace_id,
        input.task.id,
      );
      if (issues.length) parsed.issues = [...(parsed.issues ?? []), ...issues];
    }
    return { ...response, text: JSON.stringify(parsed) };
  };
}
export const createEcommerceWorkflow = (
  model: ModelAdapter = configuredModel,
  authorize?: (workspaceId: string, ownerId: string) => void,
  maxElapsedMs?: () => number,
) =>
  new EcommerceWorkflow({
    freeze: freezeTask,
    model: guardedModel(model),
    authorize,
    maxElapsedMs,
  });
