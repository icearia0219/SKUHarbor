import type {
  Evidence,
  Locale,
  Market,
  Product,
  ProductFact,
  ProductRef,
} from './domain.js';
import {
  canonicalJson,
  EcommerceError,
  getEvidence,
  getObject,
  getSourceAsset,
  listObjects,
  putObject,
  sha256,
  transact,
} from './repository.js';

export interface FactDecision {
  evidence_id: string;
  decision: 'confirm' | 'reject';
  reason: string;
}
export interface FactConflict {
  field: string;
  evidence_ids: string[];
  values: Array<{ value: ProductFact['value']; unit: string | null }>;
}
export interface InputManifest {
  workspace_id: string;
  market: Market;
  locale: Locale;
  as_of: string;
  input_revision: string;
  product_refs: ProductRef[];
  products: Product[];
  evidence: Evidence[];
}
function checkScope(market: Market, locale: Locale): void {
  if (
    !['US', 'DE'].includes(market) ||
    locale !== (market === 'US' ? 'en-US' : 'de-DE')
  )
    throw new EcommerceError('WRONG_MARKET', 'Market and locale do not match');
}
function candidate(
  workspaceId: string,
  fact: ProductFact,
  sku: string,
  market: Market,
  productId: string,
): void {
  const stored = getObject<{ sku: string; market: Market; fact: ProductFact }>(
    workspaceId,
    'fact_candidate',
    fact.evidence_id,
  )?.body;
  if (
    !stored ||
    stored.sku !== sku ||
    stored.market !== market ||
    canonicalJson({ ...fact, verification_state: 'candidate' }) !==
      canonicalJson(stored.fact)
  )
    throw new EcommerceError(
      'invalid_evidence',
      'Fact does not match the original imported SKU, market and value',
    );
  const evidence = getEvidence(workspaceId, fact.evidence_id);
  if (!evidence)
    throw new EcommerceError(
      'invalid_evidence',
      'Fact evidence is missing in this workspace',
    );
  const version = /^version:([^;]+);/.exec(evidence.locator)?.[1];
  const source = getSourceAsset(workspaceId, evidence.source_id, version);
  if (
    !source ||
    source.content_hash !== evidence.content_hash ||
    (source.product_refs.length &&
      !source.product_refs.some(
        (ref) =>
          ref.product_id === productId &&
          ref.sku === sku &&
          ref.market === market,
      ))
  )
    throw new EcommerceError(
      'invalid_evidence',
      'Fact source belongs to a different product identity',
    );
}
export function createProduct(input: Omit<Product, 'revision'>): Product {
  checkScope(input.market, input.locale);
  if (
    !input.id?.trim() ||
    !input.workspace_id?.trim() ||
    !input.sku?.trim() ||
    !input.product_type?.trim() ||
    !input.seller_scope?.trim() ||
    !Array.isArray(input.facts)
  )
    throw new EcommerceError(
      'invalid_request',
      'Product identity and scope are required',
    );
  return transact(() => {
    if (
      listObjects<Product>(input.workspace_id, 'product').some(
        (r) => r.body.sku === input.sku && r.body.market === input.market,
      )
    )
      throw new EcommerceError(
        'revision_conflict',
        'SKU already exists in this market',
      );
    for (const fact of input.facts) {
      if (fact.verification_state !== 'candidate')
        throw new EcommerceError(
          'confirmation_required',
          'New facts must remain candidates until human confirmation',
        );
      candidate(input.workspace_id, fact, input.sku, input.market, input.id);
    }
    const product: Product = { ...input, revision: 1 };
    putObject(input.workspace_id, 'product', input.id, product, 0);
    putObject(
      input.workspace_id,
      'product_revision',
      `${input.id}:1`,
      product,
      0,
    );
    return product;
  });
}
export function getProduct(
  workspaceId: string,
  productId: string,
): Product | undefined {
  return getObject<Product>(workspaceId, 'product', productId)?.body;
}
export function listProducts(workspaceId: string): Product[] {
  return listObjects<Product>(workspaceId, 'product').map((r) => r.body);
}
export function stageFactCandidates(
  workspaceId: string,
  productId: string,
  expectedRevision: number,
  incoming: ProductFact[],
): Product {
  return transact(() => {
    const current = getProduct(workspaceId, productId);
    if (!current) throw new EcommerceError('not_found', 'Product not found');
    if (current.revision !== expectedRevision)
      throw new EcommerceError('revision_conflict', 'Product facts changed');
    for (const fact of incoming) {
      if (fact.verification_state !== 'candidate')
        throw new EcommerceError(
          'confirmation_required',
          'Imported facts must remain candidates',
        );
      candidate(workspaceId, fact, current.sku, current.market, current.id);
    }
    const existing = new Set(current.facts.map((f) => f.evidence_id));
    const added = incoming.filter((fact) => {
      if (existing.has(fact.evidence_id)) return false;
      existing.add(fact.evidence_id);
      return true;
    });
    if (!added.length) return current;
    const product: Product = {
      ...current,
      revision: current.revision + 1,
      facts: [...current.facts, ...added],
    };
    putObject(workspaceId, 'product', productId, product, expectedRevision);
    putObject(
      workspaceId,
      'product_revision',
      `${productId}:${product.revision}`,
      product,
      0,
    );
    return product;
  });
}
export function extractFactCandidates(
  workspaceId: string,
  sourceId: string,
  scope: { sku: string; market: Market },
): ProductFact[] {
  const source = getSourceAsset(workspaceId, sourceId);
  if (!source) throw new EcommerceError('not_found', 'Source not found');
  if (source.market !== scope.market)
    throw new EcommerceError(
      'WRONG_MARKET',
      'Source is for a different market',
    );
  return listObjects<{
    source_id: string;
    sku: string;
    market: Market;
    fact: ProductFact;
  }>(workspaceId, 'fact_candidate')
    .map((r) => r.body)
    .filter(
      (r) =>
        r.source_id === sourceId &&
        r.sku === scope.sku &&
        r.market === scope.market,
    )
    .map((r) => r.fact);
}
export function confirmFacts(
  workspaceId: string,
  productId: string,
  expectedRevision: number,
  decisions: FactDecision[],
  actorId: string,
): Product {
  return transact(() => {
    const current = getProduct(workspaceId, productId);
    if (!current) throw new EcommerceError('not_found', 'Product not found');
    if (expectedRevision !== current.revision)
      throw new EcommerceError('revision_conflict', 'Product facts changed', {
        current_revision: current.revision,
      });
    if (
      !actorId?.trim() ||
      !decisions.length ||
      decisions.some(
        (d) =>
          !['confirm', 'reject'].includes(d.decision) ||
          !d.reason?.trim() ||
          d.reason.length > 2000,
      ) ||
      new Set(decisions.map((d) => d.evidence_id)).size !== decisions.length
    )
      throw new EcommerceError(
        'confirmation_required',
        'Every fact decision requires a human identity and reason',
      );
    const facts = current.facts.map((fact) => ({ ...fact }));
    for (const decision of decisions) {
      const fact = facts.find(
        (value) => value.evidence_id === decision.evidence_id,
      );
      if (!fact)
        throw new EcommerceError(
          'invalid_request',
          'Decision references a fact outside this product',
        );
      candidate(workspaceId, fact, current.sku, current.market, current.id);
      const evidence = getEvidence(workspaceId, fact.evidence_id)!;
      if (decision.decision === 'confirm' && evidence.kind !== 'product_fact')
        throw new EcommerceError(
          'UNSUPPORTED_CLAIM',
          'Own product facts require own product evidence, not competitor descriptions or policy',
        );
      fact.verification_state =
        decision.decision === 'confirm' ? 'confirmed' : 'rejected';
    }
    const product: Product = {
      ...current,
      revision: current.revision + 1,
      facts,
    };
    putObject(workspaceId, 'product', productId, product, expectedRevision);
    putObject(
      workspaceId,
      'product_revision',
      `${productId}:${product.revision}`,
      product,
      0,
    );
    putObject(
      workspaceId,
      'fact_review',
      `${productId}:${product.revision}`,
      {
        actor_id: actorId,
        reasoned_decisions: decisions,
        created_at: new Date().toISOString(),
        product_revision: product.revision,
      },
      0,
    );
    return product;
  });
}
export function findFactConflicts(product: Product): FactConflict[] {
  const byField = new Map<string, ProductFact[]>();
  for (const fact of product.facts.filter(
    (f) => f.verification_state === 'confirmed',
  ))
    byField.set(fact.field, [...(byField.get(fact.field) ?? []), fact]);
  return [...byField]
    .filter(
      ([, facts]) =>
        new Set(
          facts.map((f) => canonicalJson({ value: f.value, unit: f.unit })),
        ).size > 1,
    )
    .map(([field, facts]) => ({
      field,
      evidence_ids: facts.map((f) => f.evidence_id),
      values: facts.map((f) => ({ value: f.value, unit: f.unit })),
    }));
}
export function freezeInputs(request: {
  workspace_id: string;
  product_ids: string[];
  market: Market;
  locale: Locale;
  as_of: string;
}): InputManifest {
  checkScope(request.market, request.locale);
  if (
    !Number.isFinite(Date.parse(request.as_of)) ||
    !Array.isArray(request.product_ids) ||
    !request.product_ids.length ||
    new Set(request.product_ids).size !== request.product_ids.length
  )
    throw new EcommerceError(
      'invalid_request',
      'Unique products and valid as_of are required',
    );
  return transact(() => {
    const products = request.product_ids.map((id) => {
      const product = getProduct(request.workspace_id, id);
      if (!product) throw new EcommerceError('not_found', 'Product not found');
      if (
        product.market !== request.market ||
        product.locale !== request.locale
      )
        throw new EcommerceError(
          'WRONG_MARKET',
          'Product belongs to another market',
        );
      const conflicts = findFactConflicts(product);
      if (conflicts.length)
        throw new EcommerceError(
          'FACT_CONFLICT',
          'Confirmed product facts conflict',
          { product_id: id, conflicts },
        );
      return product;
    });
    const evidence = [
      ...new Set(
        products.flatMap((p) =>
          p.facts
            .filter((f) => f.verification_state === 'confirmed')
            .map((f) => f.evidence_id),
        ),
      ),
    ].map((id) => {
      const item = getEvidence(request.workspace_id, id);
      if (!item)
        throw new EcommerceError(
          'invalid_evidence',
          'Confirmed evidence no longer exists',
        );
      const version = /^version:([^;]+);/.exec(item.locator)?.[1];
      const source = getSourceAsset(
        request.workspace_id,
        item.source_id,
        version,
      );
      if (!source || source.content_hash !== item.content_hash)
        throw new EcommerceError(
          'invalid_evidence',
          'Confirmed source revision is unavailable',
        );
      if (Date.parse(source.known_at) > Date.parse(request.as_of))
        throw new EcommerceError(
          'FUTURE_EVIDENCE',
          'Product source was not known at the requested as_of time',
        );
      return item;
    });
    const productRefs = products.map((product) => ({
      product_id: product.id,
      sku: product.sku,
      revision: String(product.revision),
      market: product.market,
    }));
    const bound = { ...request, product_refs: productRefs, products, evidence };
    const manifest: InputManifest = {
      ...bound,
      input_revision: sha256(canonicalJson(bound)),
    };
    if (
      !getObject(
        request.workspace_id,
        'input_manifest',
        manifest.input_revision,
      )
    )
      putObject(
        request.workspace_id,
        'input_manifest',
        manifest.input_revision,
        manifest,
        0,
      );
    return manifest;
  });
}
