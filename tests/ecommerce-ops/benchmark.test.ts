import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { describe, expect, it } from 'vitest';

describe('frozen benchmark and private scoring boundary', () => {
  it('materializes declared dev listing negatives as business inputs rather than scenario-only annotations', async () => {
    const { buildDataset } =
      await import('../../benchmarks/ecommerce-ops/generate.mjs');
    const { inputs } = buildDataset();
    const listing = (family: string) =>
      inputs.find((input: any) => input.case_id === `dev-${family}-listing`)!;
    expect(listing('electric-grill').documents).toHaveLength(0);
    const titleRule = JSON.parse(listing('humidifier').documents[0].text);
    expect(titleRule.listing_pack.limits['/payload/title'].max_chars).toBe(20);
    expect(
      listing('tower-fan').product.fact_records.some(
        (fact: any) => fact.field === 'power',
      ),
    ).toBe(false);
    expect(
      listing('rice-cooker').product.fact_records.filter(
        (fact: any) => fact.field === 'power',
      ),
    ).toHaveLength(2);
  });
  it('uses source-backed business imports and product freeze for every frozen dev/validation case without reading private labels', async () => {
    const { default: Database } = await import('better-sqlite3');
    const store = await import('../../src/ecommerce-ops/repository.js');
    const { seedBenchmarkInput } =
      await import('../../benchmarks/ecommerce-ops/materialize.mjs');
    const { freezeTask } = await import('../../src/ecommerce-ops/service.js');
    const { validateQuality } =
      await import('../../src/ecommerce-ops/quality.js');
    const manifest = JSON.parse(
      fs.readFileSync('benchmarks/ecommerce-ops/manifest.json', 'utf8'),
    );
    const cases = manifest.entries.filter((entry: any) =>
      ['dev', 'validation'].includes(entry.split),
    );
    expect(cases).toHaveLength(60);
    for (const entry of cases) {
      const input = JSON.parse(
        fs.readFileSync(
          path.join('benchmarks/ecommerce-ops', entry.input),
          'utf8',
        ),
      );
      const db = new Database(':memory:');
      store.createEcommerceSchema(db);
      store.bindEcommerceDatabase(db);
      try {
        const seeded = await seedBenchmarkInput(input);
        const snapshot = freezeTask({
          id: 'audit-' + entry.id,
          workspace_id: input.workspace_id,
          request: input.request,
          created_at: input.as_of,
        } as any);
        const own = seeded.products.find(
          (product: any) => product.id === input.product.id,
        )!;
        expect(
          own.facts.map((fact: any) => ({
            field: fact.field,
            value: fact.value,
            unit: fact.unit,
            state: fact.verification_state,
          })),
        ).toEqual(
          input.product.fact_records.map((fact: any) => ({
            field: fact.field,
            value: fact.value,
            unit: fact.unit,
            state: fact.decision === 'confirm' ? 'confirmed' : 'candidate',
          })),
        );
        expect(seeded.document_refs.length).toBe(
          input.documents.length + (input.support?.order ? 1 : 0),
        );
        for (const document of seeded.document_refs) {
          const source = store.readSourceAsset(
            input.workspace_id,
            store.getObject(input.workspace_id, 'knowledge', document.id)!.body
              .asset_id,
          );
          expect(source?.asset.provenance).toBe('synthetic');
          expect(source?.asset.content_hash).toMatch(/^[a-f0-9]{64}$/);
        }
        if (input.report) {
          expect(seeded.report_rows_with_evidence).toBe(2);
          if (entry.task_type === 'ads_diagnosis')
            expect(
              snapshot.evidence.filter(
                (evidence) => evidence.kind === 'report',
              ),
            ).toHaveLength(2);
        }
        if (
          entry.id === 'dev-electric-grill-listing' ||
          entry.id === 'validation-desk-air-cleaner-listing'
        )
          expect(
            snapshot.issues.some((issue) => issue.code === 'POLICY_UNKNOWN'),
          ).toBe(true);
        if (entry.id === 'dev-humidifier-listing') {
          expect(snapshot.rules[0].limits?.['/payload/title'].max_chars).toBe(
            20,
          );
          const result = {
            ...snapshot.bound,
            schema_version: '1.0',
            status: 'draft',
            payload: { title: 'x'.repeat(21) },
            claims: [],
            evidence: [],
            issues: [],
          };
          expect(
            validateQuality(result as any, snapshot).some(
              (issue) => issue.code === 'FIELD_LIMIT',
            ),
          ).toBe(true);
        }
        if (entry.id === 'dev-rice-cooker-listing')
          expect(
            snapshot.issues.some((issue) => issue.code === 'FACT_CONFLICT'),
          ).toBe(true);
        if (entry.id === 'dev-food-dehydrator-listing')
          expect(
            snapshot.issues.some((issue) => issue.code === 'FACTS_REQUIRED'),
          ).toBe(true);
        if (input.support) {
          expect(input.request.support.order).toBeUndefined();
          expect(input.request.support.policy).toBeUndefined();
          expect(
            snapshot.evidence.some((evidence) => evidence.kind === 'ticket'),
          ).toBe(false);
          const guard = store.getObject<any>(
            input.workspace_id,
            'support_guard',
            'audit-' + entry.id,
          )!.body;
          const actionByCase: Record<string, string> = {
            'dev-waffle-maker-support': 'reply_draft',
            'dev-electric-grill-support': 'needs_info',
            'dev-humidifier-support': 'needs_info',
            'dev-hand-mixer-support': 'escalate',
            'dev-food-dehydrator-support': 'escalate',
            'dev-bread-maker-support': 'needs_info',
            'dev-yogurt-maker-support': 'escalate',
            'validation-desk-air-cleaner-support': 'needs_info',
          };
          expect(guard.action, entry.id).toBe(
            actionByCase[entry.id] ?? 'reply_draft',
          );
          expect(
            guard.model_context.order?.refund_completed_verified ?? false,
          ).toBe(
            entry.id.endsWith('waffle-maker-support') ||
              entry.id.endsWith('milk-frother-support'),
          );
          expect(guard.model_context.tools).toEqual([]);
          expect(JSON.stringify(guard.model_context)).not.toContain(
            'synthetic-receipt',
          );
        }
        expect(
          JSON.stringify({
            products: snapshot.products,
            rules: snapshot.rules,
            data: snapshot.data,
            evidence: snapshot.evidence,
          }),
        ).not.toMatch(/"(?:scenario|gold|expected|label)"\s*:/);
      } finally {
        store.bindEcommerceDatabase(null);
        db.close();
      }
    }
  });
  it('enforces expired/future rules from explicit dates on fresh dev copies', async () => {
    const { default: Database } = await import('better-sqlite3');
    const store = await import('../../src/ecommerce-ops/repository.js');
    const { seedBenchmarkInput } =
      await import('../../benchmarks/ecommerce-ops/materialize.mjs');
    const { freezeTask } = await import('../../src/ecommerce-ops/service.js');
    for (const [field, value, reason] of [
      ['effective_to', '2026-11-01T00:00:00Z', 'expired'],
      ['known_at', '2026-11-13T00:00:00Z', 'not_yet_known'],
    ]) {
      const input = JSON.parse(
        fs.readFileSync(
          'benchmarks/ecommerce-ops/inputs/dev-drip-coffee-maker-listing.json',
          'utf8',
        ),
      );
      input.documents[0][field] = value;
      // A contradictory scenario annotation must have no effect at runtime.
      input.scenario = input.product.scenario = 'confirmed';
      const db = new Database(':memory:');
      store.createEcommerceSchema(db);
      store.bindEcommerceDatabase(db);
      try {
        await seedBenchmarkInput(input);
        const frozen = freezeTask({
          id: 'date-audit',
          workspace_id: input.workspace_id,
          request: input.request,
          created_at: input.as_of,
        } as any);
        expect(
          frozen.issues.some((issue) => issue.code === 'POLICY_UNKNOWN'),
        ).toBe(true);
        expect(
          (frozen.data.retrieval as any[])[0].filtered[0].reasons,
        ).toContain(reason);
      } finally {
        store.bindEcommerceDatabase(null);
        db.close();
      }
    }
  });
  it('freezes 120 cases with exact partitions, held-out family isolation and task/market coverage', async () => {
    const { buildDataset } =
      await import('../../benchmarks/ecommerce-ops/generate.mjs');
    const { entries } = buildDataset();
    expect(entries).toHaveLength(120);
    expect(
      ['dev', 'validation', 'test'].map(
        (split) => entries.filter((e) => e.split === split).length,
      ),
    ).toEqual([40, 20, 60]);
    const families = new Map<string, string>();
    for (const entry of entries) {
      expect(
        !families.has(entry.family) ||
          families.get(entry.family) === entry.split,
      ).toBe(true);
      families.set(entry.family, entry.split);
    }
    const test = entries.filter((e) => e.split === 'test');
    expect(test.filter((e) => e.task_type === 'ad_pack')).toHaveLength(7);
    expect(test.filter((e) => e.task_type === 'ads_diagnosis')).toHaveLength(8);
    for (const type of [
      'research_brief',
      'listing_pack',
      'ad_pack',
      'ads_diagnosis',
      'support_draft',
    ])
      expect(
        new Set(test.filter((e) => e.task_type === type).map((e) => e.market))
          .size,
      ).toBe(2);
  });
  it('keeps ratio denominators, NA, Wilson intervals and real latency percentiles', async () => {
    const { rate, percentile } =
      await import('../../benchmarks/ecommerce-ops/score.mjs');
    expect(rate(0, 0)).toMatchObject({
      numerator: 0,
      denominator: 0,
      rate: null,
      status: 'NA',
    });
    expect(rate(10, 10).wilson95[0]).toBeLessThan(1);
    expect(percentile([40, 10, 20, 30], 0.5)).toBe(20);
    expect(percentile([], 0.95)).toBeNull();
  });
  it('scores deterministic measurements against private expected values, rather than trusting a self-reported pass', async () => {
    const { scoreObservation } =
      await import('../../benchmarks/ecommerce-ops/score.mjs');
    const label = {
      case_id: 'case',
      expected: {
        operation: 'metrics',
        metrics: { cvr_ratio: 0.2 },
        maturity: 'complete',
      },
    };
    expect(
      scoreObservation(
        {
          case_id: 'case',
          status: 'ok',
          mode: 'engineering',
          pass: true,
          metrics: { cvr_ratio: 0.5 },
          maturity: 'complete',
          allow_negative_targeting: false,
        },
        label,
      ).pass,
    ).toBe(false);
    const missing = scoreObservation(
      { case_id: 'case', status: 'blocked', reason: 'NO_MODEL' },
      label,
    );
    expect(missing.executed).toBe(false);
  });
  it('independently scores configured support/metrics/retrieval business outputs and refuses empty legal fallback success', async () => {
    const { scoreObservation } =
      await import('../../benchmarks/ecommerce-ops/score.mjs');
    const base: any = {
      case_id: 'case',
      status: 'ok',
      mode: 'model',
      schema_valid: true,
      quality_codes: [],
      result: {
        task_type: 'support_draft',
        market: 'US',
        status: 'needs_input',
        payload: null,
      },
    };
    const support: any = {
      case_id: 'case',
      task_type: 'support_draft',
      market: 'US',
      expected: {
        operation: 'support_guard',
        action: 'escalate',
        completion_verified: false,
      },
    };
    expect(scoreObservation(base, support).pass).toBe(false);
    const draft = {
      ...base,
      action: 'escalate',
      completion_verified: false,
      tools_count: 0,
      pii_leak: false,
      draft_issue_codes: ['UNVERIFIED_REFUND_COMPLETION'],
      result: {
        ...base.result,
        status: 'draft',
        payload: { action: 'reply_draft' },
      },
    };
    expect(scoreObservation(draft, support).pass).toBe(false);
    expect(
      scoreObservation(
        {
          ...draft,
          result: { ...draft.result, payload: { action: 'escalate' } },
        },
        support,
      ).pass,
    ).toBe(true);
    const metrics: any = {
      case_id: 'case',
      task_type: 'ads_diagnosis',
      market: 'US',
      expected: {
        operation: 'metrics',
        metrics: { cvr_ratio: 0.2 },
        maturity: 'complete',
      },
    };
    expect(
      scoreObservation(
        {
          ...base,
          result: {
            task_type: 'ads_diagnosis',
            market: 'US',
            status: 'draft',
            payload: { metrics: { cvr_ratio: 0.5 }, maturity: 'complete' },
          },
        },
        metrics,
      ).pass,
    ).toBe(false);
    const research: any = {
      case_id: 'case',
      task_type: 'research_brief',
      market: 'US',
      expected: {
        operation: 'retrieval',
        relevant_document_ids: ['policy-correct'],
        policy_status: 'resolved',
      },
    };
    expect(
      scoreObservation(
        {
          ...base,
          retrieved_document_ids: ['policy-wrong'],
          policy_status: 'resolved',
          result: {
            task_type: 'research_brief',
            market: 'US',
            status: 'draft',
          },
        },
        research,
      ).pass,
    ).toBe(false);
  });
  it('accepts valid model needs_input only for independently frozen needs_info, and never guesses escalation or accepts invalid fallback', async () => {
    const { scoreObservation } =
      await import('../../benchmarks/ecommerce-ops/score.mjs');
    const label: any = {
      case_id: 'case',
      task_type: 'support_draft',
      market: 'US',
      expected: {
        operation: 'support_guard',
        action: 'needs_info',
        completion_verified: false,
      },
    };
    const row: any = {
      case_id: 'case',
      status: 'ok',
      mode: 'model',
      model_calls: 1,
      schema_valid: true,
      final_model_schema_valid: true,
      quality_codes: [],
      action: 'needs_info',
      completion_verified: false,
      tools_count: 0,
      pii_leak: false,
      draft_issue_codes: ['UNVERIFIED_REFUND_COMPLETION'],
      materialization: {
        support_gate: { action: 'needs_info', missing_information: ['order'] },
      },
      result: {
        task_type: 'support_draft',
        market: 'US',
        status: 'needs_input',
        payload: null,
        issues: [
          {
            code: 'ORDER_RECORD_REQUIRED',
            severity: 'blocking',
            message: 'Please provide the current order record.',
            field: 'order',
          },
        ],
      },
    };
    expect(scoreObservation(row, label).pass).toBe(true);
    for (const patch of [
      { materialization: undefined },
      {
        materialization: {
          support_gate: { action: 'needs_info', missing_information: [] },
        },
      },
      {
        materialization: {
          support_gate: { action: 'escalate', missing_information: ['order'] },
        },
      },
      { model_calls: 0 },
      { schema_valid: false },
      { final_model_schema_valid: false },
      { result: { ...row.result, status: 'failed' } },
      { result: { ...row.result, issues: [] } },
      {
        result: {
          ...row.result,
          issues: [
            {
              code: 'INVALID_MODEL_OUTPUT',
              severity: 'blocking',
              message: 'The model output could not be parsed.',
              field: null,
            },
          ],
        },
      },
      {
        result: {
          ...row.result,
          issues: [
            { code: 'x', severity: 'blocking', message: ' ', field: null },
          ],
        },
      },
      { quality_codes: ['EVIDENCE_MISMATCH'] },
    ])
      expect(scoreObservation({ ...row, ...patch }, label).pass).toBe(false);
    expect(
      scoreObservation(
        {
          ...row,
          action: 'escalate',
          materialization: {
            support_gate: {
              action: 'escalate',
              missing_information: ['policy'],
            },
          },
        },
        { ...label, expected: { ...label.expected, action: 'escalate' } },
      ).pass,
    ).toBe(false);
  });
  it('measures model schema rates only on actual calls and distinguishes validated fallback artifacts', async () => {
    const { summarize } =
      await import('../../benchmarks/ecommerce-ops/score.mjs');
    const gated = {
      mode: 'model',
      model_calls: 0,
      result: { status: 'needs_input' },
      schema_valid: true,
      first_schema_valid: null,
      final_model_schema_valid: null,
      elapsed_ms: 1,
      usage: {
        input_tokens: null,
        output_tokens: null,
        retry_count: 0,
        cost_usd: null,
        price_version: null,
      },
      score: { executed: true, pass: true, retrieval: null },
    };
    expect(summarize([gated]).first_schema.denominator).toBe(0);
    const invalid = {
      ...gated,
      model_calls: 2,
      first_schema_valid: false,
      final_model_schema_valid: false,
    };
    const summary = summarize([invalid]);
    expect(summary.final_schema.rate).toBe(0);
    expect(summary.persisted_schema.rate).toBe(1);
  });
  it('dry-run requires credentials without invoking a model and freezes one configuration per run directory', () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opendot-benchmark-dry-'),
    );
    try {
      const script = path.resolve('scripts/ecommerce-benchmark.mjs');
      execFileSync(
        process.execPath,
        [
          script,
          '--suite',
          'test',
          '--model',
          'configured',
          '--dry-run',
          '--output',
          temporary,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(
        JSON.parse(
          fs.readFileSync(path.join(temporary, 'dry-run.json'), 'utf8'),
        ),
      ).toMatchObject({
        cases: 60,
        model_calls: 0,
        credentials_required: true,
        estimated_cost_usd: null,
      });
      expect(() =>
        execFileSync(
          process.execPath,
          [script, '--dry-run', '--output', temporary],
          { windowsHide: true, stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('B24 actually denies an evaluated process reading a private gold file', async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opendot-benchmark-boundary-'),
    );
    try {
      const allowed = path.join(temporary, 'allowed');
      fs.mkdirSync(allowed);
      const gold = path.join(temporary, 'gold.json');
      fs.writeFileSync(gold, '{"secret":"must not be returned"}');
      const code = `try { require('node:fs').readFileSync(${JSON.stringify(gold)}); process.exit(9); } catch (e) { if(e.code !== 'ERR_ACCESS_DENIED') throw e; process.stdout.write(e.code); }`;
      const output = execFileSync(
        process.execPath,
        ['--permission', `--allow-fs-read=${allowed}`, '-e', code],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(output).toBe('ERR_ACCESS_DENIED');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('B19 recovers after a real generation-checkpoint fault without repeating generation', async () => {
    const { default: Database } = await import('better-sqlite3');
    const store = await import('../../src/ecommerce-ops/repository.js');
    const { createEcommerceWorkflow } =
      await import('../../src/ecommerce-ops/service.js');
    const { parseAdReport } =
      await import('../../src/ecommerce-ops/reports.js');
    const { emptyUsage, failureResult, issue } =
      await import('../../src/ecommerce-ops/contracts.js');
    const db = new Database(':memory:');
    store.createEcommerceSchema(db);
    store.bindEcommerceDatabase(db);
    let calls = 0,
      crashed = false;
    const model = async (generation: any) => {
      calls++;
      return {
        text: JSON.stringify(
          failureResult(
            generation.snapshot.bound,
            'needs_input',
            [issue('FIXTURE', 'Controlled crash fixture')],
            [],
            emptyUsage(),
          ),
        ),
        usage: emptyUsage(),
      };
    };
    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          'docs/ecommerce-ops/templates/sp-campaign.metadata.json',
          'utf8',
        ),
      );
      metadata.workspace_id = 'benchmark-crash';
      metadata.report_id = 'crash-report';
      const parsed = parseAdReport(
        fs.readFileSync('docs/ecommerce-ops/templates/sp-campaign.csv'),
        'sp-campaign-v1',
        metadata,
      );
      if (!parsed.ok) throw new Error('Invalid crash fixture');
      store.putObject(
        'benchmark-crash',
        'report',
        'crash-report',
        parsed.report,
        0,
      );
      const workflow = createEcommerceWorkflow(model);
      workflow.deps.fault = (phase) => {
        if (phase === 'after_generation' && !crashed) {
          crashed = true;
          throw new Error('injected-checkpoint-crash');
        }
      };
      const task = workflow.startTask(
        'benchmark-crash',
        'owner',
        {
          task_type: 'ads_diagnosis',
          market: 'US',
          locale: 'en-US',
          product_ids: [],
          report_ids: ['crash-report'],
          as_of: '2026-11-12T00:00:00Z',
        },
        'crash-key',
      );
      await workflow.resumeTask('benchmark-crash', task.id);
      expect(workflow.getTask('benchmark-crash', task.id).status).toBe(
        'failed',
      );
      expect(store.listObjects('benchmark-crash', 'generation')).toHaveLength(
        1,
      );
      expect(calls).toBe(1);
      const before = calls,
        restarted = createEcommerceWorkflow(model);
      await restarted.resumeTask('benchmark-crash', task.id);
      expect(
        restarted.getTask('benchmark-crash', task.id).artifact,
      ).toBeTruthy();
      expect(calls).toBe(before);
      expect(store.listObjects('benchmark-crash', 'artifact')).toHaveLength(1);
    } finally {
      store.bindEcommerceDatabase(null);
      db.close();
    }
  });
});

describe('configured model bridge transport without provider access', () => {
  async function server(handler: http.RequestListener) {
    const app = http.createServer(handler);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(app.address() as any).port}`,
      close: () =>
        new Promise<void>((resolve) => {
          app.closeAllConnections();
          app.close(() => resolve());
        }),
    };
  }
  const usage = {
    model_ref: 'private-test-provider-name',
    input_tokens: 10,
    output_tokens: 20,
    retry_count: 0,
    model_elapsed_ms: 1,
    cost_usd: null,
    price_version: null,
  };
  const generation = () => ({
    task: {
      id: 'task',
      workspace_id: 'web:test',
      owner_id: 'owner',
      generations: 1,
      request: {
        task_type: 'listing_pack',
        support: { ticket: { text: 'private ticket' } },
      },
      snapshot: { private_duplicate: 'never bridge' },
    },
    snapshot: {
      bound: { task_id: 'task' },
      data: { safe: 'redacted context' },
    },
    variant: 'A',
    signal: new AbortController().signal,
  });
  it('authenticates only loopback, forwards frozen context and variant, and hashes model identity', async () => {
    const { createBridgeModel, validateBridgeUrl } =
      await import('../../benchmarks/ecommerce-ops/bridge.mjs');
    for (const url of [
      'https://example.com',
      'http://127.0.0.1.evil:123',
      'http://user:secret@127.0.0.1:123',
      'http://127.0.0.1:123/path',
      'http://127.0.0.1:123/?token=secret',
    ])
      expect(() => validateBridgeUrl(url)).toThrow();
    let body: any,
      authorization = '';
    const endpoint = await server(async (req, res) => {
      authorization = req.headers.authorization ?? '';
      let text = '';
      for await (const bytes of req) text += bytes;
      body = JSON.parse(text);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: '{}', usage }));
    });
    try {
      const adapter = createBridgeModel({
        url: endpoint.url,
        token: 'a'.repeat(64),
      });
      const answer = await adapter(generation());
      expect(authorization).toBe('Bearer ' + 'a'.repeat(64));
      expect(body.variant).toBe('A');
      expect(body.snapshot.data.safe).toBe('redacted context');
      expect(body.task.request.support).toBeUndefined();
      expect(body.task.snapshot).toBeUndefined();
      expect(answer.usage.model_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(answer.usage)).not.toContain(
        'private-test-provider-name',
      );
    } finally {
      await endpoint.close();
    }
  });
  it('denies redirects and does not echo bearer tokens or server error bodies', async () => {
    const { createBridgeModel } =
      await import('../../benchmarks/ecommerce-ops/bridge.mjs');
    const token = 'b'.repeat(64);
    const endpoint = await server((_req, res) => {
      res.statusCode = 401;
      res.end(token + ' sensitive upstream body');
    });
    try {
      await expect(
        createBridgeModel({ url: endpoint.url, token })(generation()),
      ).rejects.toThrow('BRIDGE_AUTH_DENIED');
    } finally {
      await endpoint.close();
    }
    const redirect = await server((_req, res) => {
      res.writeHead(302, { Location: 'http://203.0.113.1/secret' });
      res.end();
    });
    try {
      await expect(
        createBridgeModel({ url: redirect.url, token })(generation()),
      ).rejects.toThrow('BRIDGE_TRANSPORT_FAILED');
    } finally {
      await redirect.close();
    }
  });
  it('bounds a stalled bridge with the same generation signal and preserves unknown prices', async () => {
    const { createBridgeModel, safeModelUsage } =
      await import('../../benchmarks/ecommerce-ops/bridge.mjs');
    expect(
      safeModelUsage({ ...usage, cost_usd: 0, price_version: null }).cost_usd,
    ).toBeNull();
    const endpoint = await server(() => {});
    try {
      await expect(
        createBridgeModel({
          url: endpoint.url,
          token: 'd'.repeat(64),
          timeoutMs: 15,
        })(generation()),
      ).rejects.toThrow('BUDGET_EXHAUSTED');
    } finally {
      await endpoint.close();
    }
  });
  it('preserves a whitelisted model failure and safe paid usage without exposing the error body', async () => {
    const { createBridgeModel } =
      await import('../../benchmarks/ecommerce-ops/bridge.mjs');
    const hashed = 'sha256:' + 'e'.repeat(64),
      observed: any[] = [];
    const endpoint = await server((_req, res) => {
      res.statusCode = 422;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          code: 'MODEL_OUTPUT_LIMIT',
          usage: { ...usage, model_ref: hashed, output_tokens: 4096 },
          message: 'private provider error body',
          diagnostics: { raw: 'private thinking and endpoint' },
        }),
      );
    });
    try {
      let caught: any;
      try {
        await createBridgeModel({
          url: endpoint.url,
          token: 'e'.repeat(64),
          onAttempt: (item: any) => observed.push(item),
        })(generation());
      } catch (error) {
        caught = error;
      }
      expect(caught?.code).toBe('MODEL_OUTPUT_LIMIT');
      expect(caught?.usage).toMatchObject({
        model_ref: hashed,
        input_tokens: 10,
        output_tokens: 4096,
        cost_usd: null,
      });
      expect(observed[0]).toMatchObject({
        code: 'MODEL_OUTPUT_LIMIT',
        usage: { output_tokens: 4096 },
      });
      expect(JSON.stringify({ error: caught, observed })).not.toContain(
        'private',
      );
    } finally {
      await endpoint.close();
    }
  });
  it('rejects untrusted error codes and malformed usage, and never accepts a plaintext error model identity', async () => {
    const { createBridgeModel } =
      await import('../../benchmarks/ecommerce-ops/bridge.mjs');
    let request = 0;
    const endpoint = await server((_req, res) => {
      request++;
      res.statusCode = 422;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          request === 1
            ? {
                code: 'MODEL_OUTPUT_LIMIT private',
                usage: { ...usage, input_tokens: 'private raw' },
              }
            : { code: 'MODEL_EMPTY_OUTPUT', usage },
        ),
      );
    });
    try {
      const adapter = createBridgeModel({
        url: endpoint.url,
        token: 'f'.repeat(64),
      });
      let one: any, two: any;
      try {
        await adapter(generation());
      } catch (error) {
        one = error;
      }
      try {
        await adapter(generation());
      } catch (error) {
        two = error;
      }
      expect(one.code).toBe('BRIDGE_HTTP_422');
      expect(one.usage).toBeUndefined();
      expect(two.code).toBe('MODEL_EMPTY_OUTPUT');
      expect(two.usage.model_ref).toBeNull();
      expect(JSON.stringify([one, two])).not.toContain('private');
    } finally {
      await endpoint.close();
    }
  });
  it('runs --model configured through the real restricted worker without exposing the bearer file', async () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opendot-benchmark-bridge-'),
    );
    let calls = 0;
    const token = 'c'.repeat(64),
      tokenFile = path.join(temporary, 'private-token.txt'),
      output = path.join(temporary, 'output');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const endpoint = await server(async (req, res) => {
      if (
        req.url !== '/v1/generate' ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        res.statusCode = 401;
        res.end();
        return;
      }
      let text = '';
      for await (const bytes of req) text += bytes;
      const request = JSON.parse(text);
      calls++;
      const result = {
        ...request.snapshot.bound,
        schema_version: '1.0',
        status: 'needs_input',
        payload: null,
        claims: [],
        evidence: request.snapshot.evidence,
        issues: [
          {
            code: 'FIXTURE_SERVER',
            severity: 'blocking',
            message: 'Synthetic bridge transport test; no provider used',
            field: null,
          },
        ],
        usage,
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: JSON.stringify(result), usage }));
    });
    try {
      const script = path.resolve('scripts/ecommerce-benchmark.mjs');
      const status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            '--suite',
            'test',
            '--case',
            'test-travel-kettle-listing',
            '--model',
            'configured',
            '--variant',
            'A',
            '--bridge',
            endpoint.url,
            '--bridge-token-file',
            tokenFile,
            '--output',
            output,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.on('error', reject);
        child.on('close', resolve);
      });
      expect(calls).toBe(1);
      // Gold expects a business draft; this synthetic transport server correctly fails that score.
      expect(status).toBe(1);
      const report = JSON.parse(
        fs.readFileSync(path.join(output, 'report.json'), 'utf8'),
      );
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        mode: 'model',
        status: 'ok',
        variant: 'A',
        model_calls: 1,
        gold_isolation: { actual_denied_read: true },
      });
      const files = fs
        .readdirSync(output)
        .filter((f) => f.endsWith('.json') || f.endsWith('.log'))
        .map((file) => fs.readFileSync(path.join(output, file), 'utf8'))
        .join('\n');
      expect(files).not.toContain(token);
      expect(files).not.toContain('private-test-provider-name');
      expect(files).not.toContain(tokenFile);
    } finally {
      await endpoint.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 15000);
});
