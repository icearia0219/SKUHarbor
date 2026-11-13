import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createBridgeModel } from './bridge.mjs';
import { seedBenchmarkInput } from './materialize.mjs';

// No labels, scorer, generator, provider credentials or original user data are imported.
const [
  inputPath,
  outputPath,
  repository,
  mode = 'engineering',
  variant = 'B',
  canaryPath,
] = process.argv.slice(2);
const bridgeUrl = process.env.OPENDOT_BENCH_BRIDGE_URL,
  bridgeToken = process.env.OPENDOT_BENCH_BRIDGE_TOKEN;
delete process.env.OPENDOT_BENCH_BRIDGE_URL;
delete process.env.OPENDOT_BENCH_BRIDGE_TOKEN;
const source = (name) =>
  pathToFileURL(path.join(repository, 'src/ecommerce-ops', name + '.ts')).href;
const store = await import(source('repository'));
const { retrieveEvidence, resolvePolicy } = await import(source('knowledge'));
const { parseAdReport } = await import(source('reports'));
const { computeAdMetrics } = await import(source('metrics'));
const { validateSupportDraft } = await import(source('tasks/support'));
const { createEcommerceWorkflow, freezeTask } = await import(source('service'));
const { emptyUsage, failureResult, validateTaskResult, issue } = await import(
  source('contracts')
);
let denial;
try {
  fs.readFileSync(canaryPath);
  throw new Error('GOLD_WAS_READ');
} catch (error) {
  if (error.code !== 'ERR_ACCESS_DENIED') throw error;
  denial = { code: error.code, actual_denied_read: true };
}
const inputs = JSON.parse(fs.readFileSync(inputPath, 'utf8')),
  observations = [];
for (const input of inputs) {
  const started = performance.now(),
    database = new Database(':memory:');
  store.createEcommerceSchema(database);
  store.bindEcommerceDatabase(database);
  const row = {
    case_id: input.case_id,
    input_sha256: createHash('sha256')
      .update(JSON.stringify(input, null, 2) + '\n')
      .digest('hex'),
    mode,
    model:
      mode === 'contract_smoke'
        ? 'fixture'
        : mode === 'model'
          ? 'configured'
          : 'none',
    variant,
    as_of: input.as_of,
    budget: input.budget,
    usage: emptyUsage(),
    gold_isolation: denial,
  };
  try {
    if (mode === 'model' && (!bridgeUrl || !bridgeToken)) {
      observations.push({
        ...row,
        status: 'blocked',
        reason:
          'CONFIGURED_MODEL_REQUIRES_AUTHORIZED_WORKSPACE_PROVIDER_BRIDGE',
        elapsed_ms: performance.now() - started,
      });
      continue;
    }
    const materialized = await seedBenchmarkInput(input);
    const frozenTaskId = 'materialization-' + input.case_id;
    const frozen = freezeTask({
      id: frozenTaskId,
      workspace_id: input.workspace_id,
      request: input.request,
      created_at: input.as_of,
    });
    row.materialization = {
      ...materialized,
      frozen_issue_codes: frozen.issues.map((item) => item.code),
      frozen_rules: frozen.rules,
      frozen_evidence_kinds: frozen.evidence.map((item) => item.kind),
      frozen_fact_fields: frozen.products.flatMap((product) =>
        product.facts
          .filter((fact) => fact.verification_state === 'confirmed')
          .map((fact) => fact.field),
      ),
      retrieval: frozen.data.retrieval,
      support_gate: frozen.data.support_gate ?? null,
      support_order: frozen.data.support?.order ?? null,
    };
    if (input.category === 'facts') {
      const scope = {
        workspace_id: input.workspace_id,
        market: input.market,
        locale: input.locale,
        product_type: input.product.product_type,
        seller_scope: input.product.seller_scope,
        product_refs: [
          {
            product_id: input.product.id,
            sku: input.product.sku,
            revision: frozen.bound.product_refs[0].revision,
            market: input.market,
          },
        ],
        as_of: input.as_of,
        known_as_of: input.as_of,
      };
      const bundle = retrieveEvidence(input.query, scope, 5),
        policy = resolvePolicy(bundle, scope);
      Object.assign(row, {
        retrieved_document_ids: bundle.retrieved_doc_refs.map((d) => d.id),
        retrieval_trace: bundle.filtered,
        policy_status: policy.status,
        evidence_anchors: bundle.evidence.map((e) => ({
          id: e.evidence_id,
          locator: e.locator,
          hash: e.content_hash,
        })),
      });
    }
    if (input.category === 'support') {
      const prepared = store.getObject(
        input.workspace_id,
        'support_guard',
        frozenTaskId,
      )?.body;
      if (!prepared) throw new Error('SUPPORT_GUARD_MISSING');
      const candidate = {
        ticket_id: prepared.model_context.ticket_id,
        intent: 'refund',
        reply_body:
          input.market === 'US'
            ? 'Your refund has been processed.'
            : 'Ihre Erstattung wurde ausgeführt.',
        action: prepared.action,
        order_evidence_refs: prepared.model_context.order?.evidence_refs ?? [],
        internal_notes_zh: ['这是合成规则挑战，未发送消息或执行退款。'],
      };
      Object.assign(row, {
        action: prepared.action,
        completion_verified:
          prepared.model_context.order?.refund_completed_verified ?? false,
        draft_issue_codes: validateSupportDraft(candidate, prepared).map(
          (i) => i.code,
        ),
        tools_count: prepared.model_context.tools.length,
        pii_leak: JSON.stringify(prepared.model_context).includes(
          'demo@example.com',
        ),
      });
    }
    if (mode === 'engineering') {
      if (input.category === 'facts' || input.category === 'support') {
        // Already measured through the production frozen data above.
      } else if (input.task_type === 'ads_diagnosis') {
        const parsed = parseAdReport(
          input.report.csv,
          input.report.mapping,
          input.report.metadata,
        );
        if (!parsed.ok) throw new Error('REPORT_PARSE');
        Object.assign(
          row,
          computeAdMetrics(parsed.report.rows, {
            ...parsed.report.metadata,
            as_of: input.as_of,
          }),
        );
      } else {
        observations.push({
          ...row,
          status: 'blocked',
          reason: 'LANGUAGE_GENERATION_NOT_RUN_IN_ENGINEERING_MODE',
          elapsed_ms: performance.now() - started,
        });
        continue;
      }
    } else {
      let modelCalls = 0,
        firstSchema = null,
        finalModelSchema = null;
      const attempts = [];
      const bridge =
        mode === 'model'
          ? createBridgeModel({
              url: bridgeUrl,
              token: bridgeToken,
              timeoutMs: input.budget.max_elapsed_ms,
              onAttempt: (attempt) => attempts.push(attempt),
            })
          : null;
      const fixtureModel = async (generation) => {
        // This intentionally generates no faux Listing/ad/customer language.
        const result = failureResult(
          generation.snapshot.bound,
          'needs_input',
          [
            issue(
              'FIXTURE_CONTRACT_ONLY',
              'Synthetic deterministic contract smoke; natural-language generation is not evaluated.',
            ),
          ],
          generation.snapshot.evidence,
          {
            ...emptyUsage(),
            model_ref: 'synthetic-deterministic-contract-fixture',
          },
        );
        return { text: JSON.stringify(result), usage: result.usage };
      };
      const adapter = async (generation) => {
        modelCalls++;
        try {
          const response = await (bridge ?? fixtureModel)({
            ...generation,
            variant,
          });
          let valid = false;
          try {
            valid = validateTaskResult(
              JSON.parse(
                response.text
                  .replace(/^```(?:json)?\s*/, '')
                  .replace(/\s*```$/, ''),
              ),
              generation.snapshot.bound,
            ).ok;
          } catch {
            /* invalid JSON is a measured failure */
          }
          firstSchema ??= valid;
          finalModelSchema = valid;
          return response;
        } catch (error) {
          firstSchema ??= false;
          finalModelSchema = false;
          throw error;
        }
      };
      const workflow = createEcommerceWorkflow(
        adapter,
        undefined,
        () => input.budget.max_elapsed_ms,
      );
      const task = workflow.startTask(
        input.workspace_id,
        'controlled-fixture-author',
        input.request,
        'benchmark-' + input.case_id,
      );
      await workflow.resumeTask(input.workspace_id, task.id);
      const completed = workflow.getTask(input.workspace_id, task.id),
        artifact = completed.artifact;
      if (!artifact) throw new Error(completed.error ?? 'ARTIFACT_MISSING');
      Object.assign(row, {
        result: artifact.result,
        quality_codes: artifact.quality
          .filter((i) => i.severity === 'blocking')
          .map((i) => i.code),
        schema_valid: validateTaskResult(
          artifact.result,
          completed.snapshot.bound,
        ).ok,
        first_schema_valid: firstSchema,
        final_model_schema_valid: finalModelSchema,
        usage: artifact.result.usage,
        model_calls: modelCalls,
        model_attempts: attempts,
        task_status: completed.status,
        freeze_hash: completed.input_revision,
      });
    }
    observations.push({
      ...row,
      status: 'ok',
      elapsed_ms: performance.now() - started,
    });
  } catch (error) {
    observations.push({
      ...row,
      status: 'error',
      error_code: error.code ?? error.message?.slice(0, 180) ?? 'WORKER_ERROR',
      elapsed_ms: performance.now() - started,
    });
  } finally {
    store.bindEcommerceDatabase(null);
    database.close();
  }
}
fs.writeFileSync(outputPath, JSON.stringify(observations, null, 2) + '\n');
process.stdout.write(
  JSON.stringify({
    observations: observations.length,
    gold_isolation: denial,
  }) + '\n',
);
