import { importAssets } from '../../src/ecommerce-ops/ingest.ts';
import {
  createProduct,
  confirmFacts,
  getProduct,
} from '../../src/ecommerce-ops/facts.ts';
import { ingestKnowledge } from '../../src/ecommerce-ops/knowledge.ts';
import { parseAdReport } from '../../src/ecommerce-ops/reports.ts';
import * as store from '../../src/ecommerce-ops/repository.ts';

// Only visible source records enter here. No scenario names, labels, gold or
// expected outputs are interpreted by the evaluated process.
const assetMeta = (input, kind, source_id, patch = {}) => ({
  kind,
  source_id,
  provenance: 'synthetic',
  owner_scope: input.workspace_id,
  market: input.market,
  locale: input.locale,
  product_refs: [],
  observed_at: '2026-01-01T00:00:00Z',
  known_at: '2026-01-01T00:00:00Z',
  rights_note:
    'Controlled synthetic benchmark source; no actual platform policy, order or product',
  ...patch,
});

async function seedProduct(input, raw) {
  const market = raw.market ?? input.market,
    locale = raw.locale ?? input.locale;
  if (!Array.isArray(raw.fact_records))
    throw new Error('EXPLICIT_FACT_RECORDS_REQUIRED');
  const rows = raw.fact_records.map(({ field, value, unit }) => ({
    sku: raw.sku,
    field,
    value,
    unit,
  }));
  const batch = await importAssets(
    input.workspace_id,
    [
      {
        filename: 'facts.json',
        bytes: Buffer.from(JSON.stringify(rows)),
        metadata: assetMeta(input, 'product_fact', raw.id + '-facts', {
          market,
          locale,
        }),
      },
    ],
    {},
    raw.id + '-fact-import',
  );
  if (batch.row_errors.length || batch.rows.length !== rows.length)
    throw new Error('FIXTURE_FACT_IMPORT_FAILED');
  const own = createProduct({
    id: raw.id,
    workspace_id: input.workspace_id,
    sku: raw.sku,
    market,
    locale,
    product_type: raw.product_type,
    seller_scope: raw.seller_scope,
    facts: batch.rows.map((row) => row.fact),
  });
  const decisions = batch.rows.flatMap((row, index) =>
    raw.fact_records[index].decision === 'confirm'
      ? [
          {
            evidence_id: row.fact.evidence_id,
            decision: 'confirm',
            reason: 'Synthetic fixture control, not a real human verification',
          },
        ]
      : [],
  );
  if (decisions.length)
    confirmFacts(
      input.workspace_id,
      raw.id,
      own.revision,
      decisions,
      'controlled-fixture-author',
    );
}

async function seedDocument(input, document) {
  const imported = await importAssets(
    input.workspace_id,
    [
      {
        filename: 'source.txt',
        bytes: Buffer.from(document.text),
        metadata: assetMeta(
          input,
          document.kind ?? 'policy',
          document.id + '-asset',
          {
            market: document.market,
            locale: document.locale,
            product_refs: document.product_refs ?? [],
            effective_from: document.effective_from,
            effective_to: document.effective_to,
            known_at: document.known_at,
          },
        ),
      },
    ],
    {},
    document.id + '-import',
  );
  return ingestKnowledge(input.workspace_id, imported.assets[0].source_id, {
    id: document.id,
    product_type: document.product_type,
    seller_scope: document.seller_scope,
    authority: document.authority,
    approval_state: document.approval_state,
    known_at: document.known_at,
    policy_id: document.policy_id,
    product_refs: document.product_refs,
  });
}

export async function seedBenchmarkInput(input) {
  const ws = input.workspace_id;
  await seedProduct(input, input.product);
  for (const product of input.related_products ?? [])
    await seedProduct(input, product);
  for (const document of input.documents) await seedDocument(input, document);
  if (input.report) {
    const batch = await importAssets(
      ws,
      [
        {
          filename: 'report.csv',
          bytes: Buffer.from(input.report.csv),
          metadata: assetMeta(
            input,
            'report',
            input.report.metadata.report_id + '-source',
          ),
        },
      ],
      {},
      'report-source',
    );
    const parsed = parseAdReport(
      input.report.csv,
      input.report.mapping,
      input.report.metadata,
    );
    if (!parsed.ok) throw new Error('FIXTURE_REPORT_INVALID');
    store.putObject(
      ws,
      'report',
      parsed.report.metadata.report_id,
      parsed.report,
      0,
    );
    // Same immutable row evidence as the product reports import endpoint.
    for (const row of parsed.report.rows)
      store.putEvidence(ws, {
        evidence_id: row.evidence_id,
        source_id: batch.assets[0].source_id,
        kind: 'report',
        locator: `row:${row.source_row}`,
        content_hash: batch.assets[0].content_hash,
        provenance: 'synthetic',
        excerpt: JSON.stringify(row),
      });
    input.request.report_ids = [parsed.report.metadata.report_id];
  }
  if (input.support) {
    const ticket = input.support.ticket;
    const imported = await importAssets(
      ws,
      [
        {
          filename: 'ticket.txt',
          bytes: Buffer.from(ticket.text),
          metadata: assetMeta(
            input,
            'ticket',
            input.case_id + '-ticket-source',
          ),
        },
      ],
      {},
      'ticket-source',
    );
    input.request.support = { ticket: { ...ticket } };
    input.request.asset_ids = [imported.assets[0].source_id];
    if (input.support.order) {
      const own = getProduct(ws, input.product.id);
      const raw = input.support.order;
      const effect = (value) =>
        value
          ? {
              state: value.state,
              ...(value.receipt
                ? {
                    receipt: {
                      id: value.receipt.id,
                      completed_at: value.receipt.completed_at,
                    },
                  }
                : {}),
            }
          : undefined;
      const order = {
        observed_at: raw.observed_at,
        valid_until: raw.valid_until,
        ownership_verified: raw.ownership_verified,
        refund: effect(raw.refund),
        replacement: effect(raw.replacement),
      };
      const document = await seedDocument(input, {
        id: input.case_id + '-order',
        kind: 'order',
        text: JSON.stringify(order),
        market: input.market,
        locale: input.locale,
        authority: 'merchant',
        approval_state: 'approved',
        effective_from: null,
        effective_to: null,
        known_at: '2026-01-01T00:00:00Z',
        product_type: own.product_type,
        seller_scope: own.seller_scope,
        product_refs: [
          {
            product_id: own.id,
            sku: own.sku,
            revision: String(own.revision),
            market: own.market,
          },
        ],
      });
      input.request.asset_ids.push(document.asset_id);
    }
  }
  return {
    products: store.listObjects(ws, 'product').map((row) => row.body),
    document_refs: store.listObjects(ws, 'knowledge').map((row) => ({
      id: row.id,
      kind: row.body.kind,
      market: row.body.market,
      approval_state: row.body.approval_state,
      effective_from: row.body.effective_from,
      effective_to: row.body.effective_to,
      known_at: row.body.known_at,
      product_refs: row.body.product_refs,
    })),
    report_rows_with_evidence: input.report
      ? store
          .getObject(ws, 'report', input.report.metadata.report_id)
          .body.rows.filter((row) => !!store.getEvidence(ws, row.evidence_id))
          .length
      : 0,
  };
}
