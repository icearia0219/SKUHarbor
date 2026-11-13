import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCORER_REVISION = '2.0';

// A genuine request for missing information is an allowed business outcome.
// Establish the need from code-owned frozen guards, never from a model assertion
// or a case/scenario name. Invalid/error fallbacks cannot satisfy this predicate.
function correctSupportNeedsInput(observation, expected) {
  const result = observation.result,
    gate = observation.materialization?.support_gate;
  return (
    expected.action === 'needs_info' &&
    observation.action === 'needs_info' &&
    gate?.action === 'needs_info' &&
    Array.isArray(gate.missing_information) &&
    gate.missing_information.length > 0 &&
    observation.mode === 'model' &&
    observation.model_calls > 0 &&
    observation.schema_valid === true &&
    observation.final_model_schema_valid === true &&
    result?.status === 'needs_input' &&
    result.payload === null &&
    Array.isArray(result.issues) &&
    result.issues.some(
      (item) =>
        item.severity === 'blocking' &&
        typeof item.code === 'string' &&
        item.code.trim() &&
        !/^(?:INVALID_|MODEL_|BRIDGE_|SCHEMA_|BUDGET_|CONTEXT_BUDGET_|OWNER_|CANCELLED$)/i.test(
          item.code,
        ) &&
        typeof item.message === 'string' &&
        item.message.trim(),
    )
  );
}

export function rate(numerator, denominator) {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    numerator < 0 ||
    denominator < 0 ||
    numerator > denominator
  )
    throw new Error('Invalid metric counts');
  if (!denominator)
    return { numerator, denominator, rate: null, wilson95: null, status: 'NA' };
  const p = numerator / denominator,
    z = 1.959963984540054,
    z2 = z * z,
    divisor = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / divisor;
  const half =
    (z *
      Math.sqrt(
        (p * (1 - p)) / denominator + z2 / (4 * denominator * denominator),
      )) /
    divisor;
  return {
    numerator,
    denominator,
    rate: p,
    wilson95: [Math.max(0, center - half), Math.min(1, center + half)],
    status: 'observed',
  };
}
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
    : null;
}
function close(actual, expected) {
  return (
    actual === expected ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) <= 1e-6)
  );
}
export function scoreObservation(observation, label) {
  const expected = label.expected,
    details = [];
  if (observation.case_id !== label.case_id)
    throw new Error('Case/label binding mismatch');
  if (observation.status === 'blocked')
    return {
      case_id: label.case_id,
      executed: false,
      pass: false,
      details: [observation.reason],
      retrieval: null,
    };
  if (observation.status === 'error')
    return {
      case_id: label.case_id,
      executed: true,
      pass: false,
      details: [observation.error_code ?? 'worker_error'],
      retrieval: null,
    };
  let retrieval = null;
  if (observation.mode === 'contract_smoke') {
    if (!observation.schema_valid)
      details.push('fixture_contract_schema_or_binding');
    if (
      observation.result?.task_type !== label.task_type ||
      observation.result?.market !== label.market
    )
      details.push('fixture_task_or_market');
  } else if (observation.mode === 'engineering') {
    if (expected.operation === 'retrieval') {
      const actual = observation.retrieved_document_ids ?? [],
        gold = expected.relevant_document_ids;
      const found = gold.filter((id) => actual.includes(id)).length;
      retrieval = {
        numerator: found,
        denominator: gold.length,
        query_count: 1,
        irrelevant_count: actual.filter((id) => !gold.includes(id)).length,
      };
      if (found !== gold.length || actual.some((id) => !gold.includes(id)))
        details.push('retrieval_scope_or_recall');
      if (observation.policy_status !== expected.policy_status)
        details.push('policy_resolution');
    } else if (expected.operation === 'metrics') {
      for (const [key, value] of Object.entries(expected.metrics))
        if (!close(observation.metrics?.[key], value))
          details.push(`metric:${key}`);
      if (observation.maturity !== expected.maturity)
        details.push('attribution_maturity');
      if (observation.allow_negative_targeting !== false)
        details.push('unsafe_targeting_action');
    } else if (expected.operation === 'support_guard') {
      if (observation.action !== expected.action)
        details.push('support_branch');
      if (observation.completion_verified !== expected.completion_verified)
        details.push('support_receipt');
      if (
        !expected.completion_verified &&
        !observation.draft_issue_codes?.includes('UNVERIFIED_REFUND_COMPLETION')
      )
        details.push('unsupported_completion_not_blocked');
      if (observation.tools_count !== 0)
        details.push('unexpected_support_tools');
      if (observation.pii_leak) details.push('support_pii_leak');
    } else details.push('not_an_engineering_case');
  } else {
    const result = observation.result;
    if (!observation.schema_valid) details.push('schema_or_binding');
    if (
      result?.task_type !== label.task_type ||
      result?.market !== label.market
    )
      details.push('task_or_market');
    if (expected.status && result?.status !== expected.status)
      details.push('expected_generation_status');
    if ((observation.quality_codes ?? []).length)
      details.push('business_quality_blockers');
    if (expected.operation === 'retrieval') {
      const actual = observation.retrieved_document_ids ?? [],
        gold = expected.relevant_document_ids;
      const found = gold.filter((id) => actual.includes(id)).length;
      retrieval = {
        numerator: found,
        denominator: gold.length,
        query_count: 1,
        irrelevant_count: actual.filter((id) => !gold.includes(id)).length,
      };
      if (found !== gold.length || actual.some((id) => !gold.includes(id)))
        details.push('retrieval_scope_or_recall');
      if (observation.policy_status !== expected.policy_status)
        details.push('policy_resolution');
    }
    if (expected.operation === 'metrics') {
      if (result?.status !== 'draft' || !result.payload)
        details.push('metrics_draft_required');
      for (const [key, value] of Object.entries(expected.metrics))
        if (!close(result?.payload?.metrics?.[key], value))
          details.push(`metric:${key}`);
      if (result?.payload?.maturity !== expected.maturity)
        details.push('attribution_maturity');
    }
    if (expected.operation === 'support_guard') {
      const correctNeedsInput = correctSupportNeedsInput(observation, expected);
      if (!correctNeedsInput && (result?.status !== 'draft' || !result.payload))
        details.push('support_draft_required');
      if (
        (!correctNeedsInput && result?.payload?.action !== expected.action) ||
        observation.action !== expected.action
      )
        details.push('support_branch');
      if (observation.completion_verified !== expected.completion_verified)
        details.push('support_receipt');
      if (
        !expected.completion_verified &&
        !observation.draft_issue_codes?.includes('UNVERIFIED_REFUND_COMPLETION')
      )
        details.push('unsupported_completion_not_blocked');
      if (observation.tools_count !== 0)
        details.push('unexpected_support_tools');
      if (observation.pii_leak) details.push('support_pii_leak');
    }
    if (
      result?.status === 'draft' &&
      result.task_type === 'ad_pack' &&
      result.payload?.copies?.length !== 3
    )
      details.push('ad_copies');
    if (result?.status === 'draft' && result.task_type === 'listing_pack') {
      const content = JSON.stringify(result.payload);
      if (
        expected.expected_power_w &&
        !content.includes(String(expected.expected_power_w))
      )
        details.push('missing_required_power');
      if (
        expected.expected_voltage_v &&
        !content.includes(String(expected.expected_voltage_v))
      )
        details.push('missing_required_voltage');
    }
  }
  return {
    case_id: label.case_id,
    executed: true,
    pass: details.length === 0,
    details,
    retrieval,
  };
}
export function summarize(rows) {
  const executed = rows.filter((row) => row.score.executed),
    successful = executed.filter((row) => row.score.pass);
  const generated = executed.filter(
      (row) => row.mode === 'model' && row.model_calls > 0,
    ),
    first = generated.filter((row) => row.first_schema_valid === true),
    valid = generated.filter((row) => row.final_model_schema_valid === true);
  const persisted = executed.filter(
    (row) => row.mode === 'model' && row.result,
  );
  const smoke = executed.filter((row) => row.mode === 'contract_smoke');
  const retrieval = executed.map((r) => r.score.retrieval).filter(Boolean),
    tokens = generated.map((r) => r.usage).filter(Boolean);
  const hasPrice = (row) =>
    typeof row.usage?.cost_usd === 'number' &&
    typeof row.usage.price_version === 'string' &&
    row.usage.price_version.length > 0;
  const priced = successful.filter(hasPrice);
  return {
    eligible: rows.length,
    executed: executed.length,
    blocked: rows.length - executed.length,
    case_pass: rate(successful.length, executed.length),
    first_schema: rate(first.length, generated.length),
    final_schema: rate(valid.length, generated.length),
    persisted_schema: rate(
      persisted.filter((row) => row.schema_valid).length,
      persisted.length,
    ),
    model_tasks: generated.length,
    model_calls: generated.reduce((sum, row) => sum + row.model_calls, 0),
    fixture_contract_schema: rate(
      smoke.filter((r) => r.schema_valid).length,
      smoke.length,
    ),
    recall_at_5: rate(
      retrieval.reduce((s, r) => s + r.numerator, 0),
      retrieval.reduce((s, r) => s + r.denominator, 0),
    ),
    retrieval_queries: retrieval.reduce((s, r) => s + r.query_count, 0),
    retrieval_note:
      'One query per case; common-family cases are correlated synthetic observations.',
    latency_ms: {
      p50: percentile(
        executed.map((r) => r.elapsed_ms),
        0.5,
      ),
      p95: percentile(
        executed.map((r) => r.elapsed_ms),
        0.95,
      ),
    },
    model_latency_ms: {
      p50: percentile(
        generated.map((row) => row.usage?.model_elapsed_ms),
        0.5,
      ),
      p95: percentile(
        generated.map((row) => row.usage?.model_elapsed_ms),
        0.95,
      ),
    },
    retries: tokens.reduce((s, u) => s + (u.retry_count ?? 0), 0),
    input_tokens:
      tokens.length && tokens.every((u) => Number.isInteger(u.input_tokens))
        ? tokens.reduce((s, u) => s + u.input_tokens, 0)
        : null,
    output_tokens:
      tokens.length && tokens.every((u) => Number.isInteger(u.output_tokens))
        ? tokens.reduce((s, u) => s + u.output_tokens, 0)
        : null,
    cost_usd:
      executed.length && executed.every(hasPrice)
        ? executed.reduce((s, r) => s + r.usage.cost_usd, 0)
        : null,
    cost_status:
      executed.length && executed.every(hasPrice) ? 'known' : 'unknown',
    cost_per_success_usd:
      successful.length && priced.length === successful.length
        ? priced.reduce((s, r) => s + r.usage.cost_usd, 0) / successful.length
        : null,
    human_review: 'not_reviewed',
    language_quality: 'not_evaluated',
    business_trial: 'not_run',
    revenue_effect: 'not_evaluated',
  };
}

/** Separate scoring process: only this executable opens gold labels. */
export function scoreRun(manifestPath, observationsPath, outputPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    root = path.dirname(manifestPath);
  const observations = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
  const rows = observations.map((observation) => {
    const entry = manifest.entries.find((e) => e.id === observation.case_id);
    if (!entry) throw new Error('Observation is not in frozen manifest');
    if (observation.input_sha256 !== entry.input_sha256)
      throw new Error(`Observed input hash changed: ${entry.id}`);
    const bytes = fs.readFileSync(path.join(root, entry.label));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.label_sha256)
      throw new Error(`Label hash changed: ${entry.id}`);
    return {
      ...observation,
      task_type: entry.task_type,
      market: entry.market,
      score: scoreObservation(observation, JSON.parse(bytes)),
    };
  });
  const groups = {};
  for (const row of rows) {
    const key = `${row.task_type}:${row.market}`;
    (groups[key] ??= []).push(row);
  }
  const report = {
    scorer_revision: SCORER_REVISION,
    dataset: manifest.dataset,
    freeze_sha256: manifest.freeze_sha256,
    data_status: manifest.source,
    model_status: rows[0]?.model ?? 'none',
    ab_completed: false,
    acceptance: 'offline_engineering_only',
    overall: summarize(rows),
    by_task_market: Object.fromEntries(
      Object.entries(groups).map(([key, value]) => [key, summarize(value)]),
    ),
    rows,
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = scoreRun(...process.argv.slice(2));
    process.stdout.write(
      JSON.stringify({
        executed: report.overall.executed,
        blocked: report.overall.blocked,
        pass: report.overall.case_pass,
      }) + '\n',
    );
    if (report.rows.some((r) => r.score.executed && !r.score.pass))
      process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Scoring failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
