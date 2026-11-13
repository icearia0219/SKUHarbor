import type {
  EvidenceBundle,
  EvidenceScope,
  KnowledgeRevision,
  Market,
  ObjectRecord,
  ProductRef,
} from './domain.js';
import {
  canonicalJson,
  EcommerceError,
  getObject,
  listObjects,
  putEvidence,
  putObject,
  readSourceAsset,
  sha256,
  transact,
} from './repository.js';

export interface KnowledgeMetadata {
  id: string;
  product_type: string;
  seller_scope: string;
  authority: KnowledgeRevision['authority'];
  approval_state: KnowledgeRevision['approval_state'];
  policy_id?: string;
  asset_version?: string;
  version?: string;
  product_refs?: ProductRef[];
  kind?: KnowledgeRevision['kind'];
  effective_from?: string | null;
  effective_to?: string | null;
  known_at?: string;
}
export interface KnowledgeDocument extends KnowledgeRevision {
  policy_id: string;
}
export interface RetrievedEvidenceBundle extends EvidenceBundle {
  applicable_documents?: KnowledgeDocument[];
  policy_documents: KnowledgeDocument[];
}
export interface PolicyConflict {
  policy_id: string;
  document_ids: string[];
  reason: string;
}
export interface PolicyResolution {
  status: 'resolved' | 'conflict' | 'unknown';
  policy_snapshot_id: string | null;
  conflicts: PolicyConflict[];
  document_refs: Array<{ id: string; revision: number; version: string }>;
  evidence_refs: string[];
}
export interface KnowledgeScope {
  market: Market;
  product_type: string;
  seller_scope: string;
  epoch: number;
}
export function knowledgeScopeId(
  market: Market,
  productType: string,
  sellerScope: string,
): string {
  return sha256(canonicalJson([market, productType, sellerScope]));
}
/** Freeze an empty collection too, so its first policy invalidates earlier drafts. */
export function ensureKnowledgeScope(
  workspaceId: string,
  scope: Pick<KnowledgeScope, 'market' | 'product_type' | 'seller_scope'>,
): ObjectRecord<KnowledgeScope> {
  if (
    !workspaceId ||
    !['US', 'DE'].includes(scope.market) ||
    !scope.product_type?.trim() ||
    !scope.seller_scope?.trim()
  )
    throw new EcommerceError(
      'invalid_scope',
      'Knowledge collection scope is required',
    );
  return transact(() => {
    const id = knowledgeScopeId(
      scope.market,
      scope.product_type,
      scope.seller_scope,
    );
    return (
      getObject<KnowledgeScope>(workspaceId, 'knowledge_scope', id) ??
      putObject(
        workspaceId,
        'knowledge_scope',
        id,
        {
          market: scope.market,
          product_type: scope.product_type,
          seller_scope: scope.seller_scope,
          epoch: 0,
        },
        0,
      )
    );
  });
}
const authorityWeight = {
  official: 4,
  manufacturer: 3,
  merchant: 2,
  experience: 1,
} as const;
function validTime(value: string | null, label: string): void {
  if (
    value !== null &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
  )
    throw new EcommerceError('invalid_metadata', `Invalid ${label}`);
}
export function ingestKnowledge(
  workspaceId: string,
  assetId: string,
  metadata: KnowledgeMetadata,
  expectedRevision = 0,
): KnowledgeDocument {
  const source = readSourceAsset(workspaceId, assetId, metadata.asset_version);
  if (!source)
    throw new EcommerceError('not_found', 'Knowledge source not found');
  const { asset, text } = source;
  if (
    !metadata.id?.trim() ||
    !metadata.product_type?.trim() ||
    !metadata.seller_scope?.trim() ||
    !Object.hasOwn(authorityWeight, metadata.authority) ||
    !['pending', 'approved', 'withdrawn'].includes(metadata.approval_state)
  )
    throw new EcommerceError(
      'invalid_metadata',
      'Knowledge identity, scope, authority and review state are required',
    );
  if (
    (metadata.kind && metadata.kind !== asset.kind) ||
    (asset.kind === 'competitor' && metadata.authority === 'official')
  )
    throw new EcommerceError(
      'invalid_scope',
      'Knowledge cannot relabel the source or upgrade competitor descriptions to official policy',
    );
  const effectiveFrom =
    metadata.effective_from === undefined
      ? asset.effective_from
      : metadata.effective_from;
  const effectiveTo =
    metadata.effective_to === undefined
      ? asset.effective_to
      : metadata.effective_to;
  const knownAt = metadata.known_at ?? new Date().toISOString();
  validTime(effectiveFrom, 'effective_from');
  validTime(effectiveTo, 'effective_to');
  validTime(knownAt, 'known_at');
  if (
    Date.parse(knownAt) < Date.parse(asset.known_at) ||
    (effectiveFrom &&
      effectiveTo &&
      Date.parse(effectiveFrom) >= Date.parse(effectiveTo))
  )
    throw new EcommerceError(
      'invalid_metadata',
      'Knowledge cannot predate source knowledge or have an empty validity interval',
    );
  const refs = metadata.product_refs ?? asset.product_refs;
  if (
    refs.some(
      (ref) =>
        ref.market !== asset.market ||
        !ref.product_id ||
        !ref.sku ||
        !ref.revision,
    ) ||
    (asset.product_refs.length &&
      (!refs.length ||
        refs.some(
          (r) =>
            !asset.product_refs.some(
              (sourceRef) => canonicalJson(sourceRef) === canonicalJson(r),
            ),
        )))
  )
    throw new EcommerceError(
      'invalid_scope',
      'Knowledge product scope exceeds source scope',
    );
  return transact(() => {
    const previous = getObject<KnowledgeDocument>(
      workspaceId,
      'knowledge',
      metadata.id,
    )?.body;
    if (previous && Date.parse(previous.known_at) >= Date.parse(knownAt))
      throw new EcommerceError(
        'invalid_metadata',
        'Each knowledge revision must have a strictly later system known time',
      );
    if (
      previous &&
      (previous.market !== asset.market ||
        previous.product_type !== metadata.product_type ||
        previous.seller_scope !== metadata.seller_scope)
    )
      throw new EcommerceError(
        'invalid_scope',
        'Use a new document identity for a different knowledge collection scope',
      );
    const revision = expectedRevision + 1;
    const document: KnowledgeDocument = {
      id: metadata.id,
      workspace_id: workspaceId,
      revision,
      asset_id: assetId,
      asset_version: asset.version,
      market: asset.market,
      locale: asset.locale,
      product_type: metadata.product_type,
      seller_scope: metadata.seller_scope,
      product_refs: refs,
      kind: asset.kind,
      authority: metadata.authority,
      approval_state: metadata.approval_state,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      known_at: knownAt,
      version: metadata.version ?? String(revision),
      policy_id: metadata.policy_id ?? metadata.id,
      chunks: [],
    };
    // Character offsets refer to the immutable, complete extracted text, never the chat preview.
    const chunkSize = 1200;
    for (let start = 0; start < text.length; start += chunkSize) {
      const end = Math.min(text.length, start + chunkSize);
      const excerpt = text.slice(start, end);
      if (!excerpt.trim()) continue;
      const chunk = {
        evidence_id: `ev_${sha256(`${assetId}:${asset.version}:${start}:${end}`).slice(0, 32)}`,
        source_id: assetId,
        kind: asset.kind,
        locator: `version:${asset.version};chars:${start}-${end}`,
        content_hash: asset.content_hash,
        provenance: asset.provenance,
        excerpt,
      };
      putEvidence(workspaceId, chunk);
      document.chunks.push(chunk);
    }
    putObject(
      workspaceId,
      'knowledge',
      metadata.id,
      document,
      expectedRevision,
    );
    putObject(
      workspaceId,
      'knowledge_revision',
      `${metadata.id}:${revision}`,
      document,
      0,
    );
    const collection = ensureKnowledgeScope(workspaceId, document);
    putObject(
      workspaceId,
      'knowledge_scope',
      collection.id,
      { ...collection.body, epoch: collection.body.epoch + 1 },
      collection.revision,
    );
    return document;
  });
}
function filterReasons(
  document: KnowledgeDocument,
  scope: EvidenceScope,
): string[] {
  const reasons: string[] = [];
  if (document.workspace_id !== scope.workspace_id)
    reasons.push('wrong_workspace');
  if (
    document.market !== scope.market ||
    (scope.locale && document.locale !== scope.locale)
  )
    reasons.push('wrong_market');
  if (document.product_type !== scope.product_type)
    reasons.push('wrong_product_type');
  if (document.seller_scope !== scope.seller_scope)
    reasons.push('wrong_seller_scope');
  if (document.approval_state !== 'approved') reasons.push('not_approved');
  if (Date.parse(document.known_at) > Date.parse(scope.known_as_of))
    reasons.push('not_yet_known');
  if (document.kind === 'policy' && !document.effective_from)
    reasons.push('applicability_unknown');
  if (
    document.effective_from &&
    Date.parse(document.effective_from) > Date.parse(scope.as_of)
  )
    reasons.push('not_yet_effective');
  if (
    document.effective_to &&
    Date.parse(document.effective_to) <= Date.parse(scope.as_of)
  )
    reasons.push('expired');
  if (
    document.product_refs.length &&
    !document.product_refs.some((ref) =>
      scope.product_refs?.some(
        (p) =>
          p.product_id === ref.product_id &&
          p.sku === ref.sku &&
          p.market === ref.market &&
          p.revision === ref.revision,
      ),
    )
  )
    reasons.push('wrong_product');
  return reasons;
}
export function retrieveEvidence(
  query: string,
  scope: EvidenceScope,
  topK = 5,
): RetrievedEvidenceBundle {
  if (
    !query?.trim() ||
    query.length > 2000 ||
    !Number.isSafeInteger(topK) ||
    topK < 1 ||
    topK > 100 ||
    !scope.workspace_id ||
    !scope.product_type ||
    !scope.seller_scope ||
    !['US', 'DE'].includes(scope.market)
  )
    throw new EcommerceError(
      'invalid_request',
      'A bounded query and complete retrieval scope are required',
    );
  validTime(scope.as_of, 'as_of');
  validTime(scope.known_as_of, 'known_as_of');
  if (
    scope.locale &&
    scope.locale !== (scope.market === 'US' ? 'en-US' : 'de-DE')
  )
    throw new EcommerceError(
      'invalid_scope',
      'Retrieval locale does not match market',
    );
  const filtered: EvidenceBundle['filtered'] = [],
    applicable: KnowledgeDocument[] = [];
  const revisions = listObjects<KnowledgeDocument>(
    scope.workspace_id,
    'knowledge_revision',
  ).map((r) => r.body);
  const grouped = new Map<string, KnowledgeDocument[]>();
  for (const document of revisions)
    grouped.set(document.id, [...(grouped.get(document.id) ?? []), document]);
  for (const [id, history] of grouped) {
    history.sort(
      (a, b) =>
        Date.parse(b.known_at) - Date.parse(a.known_at) ||
        b.revision - a.revision,
    );
    const document =
      history.find(
        (d) => Date.parse(d.known_at) <= Date.parse(scope.known_as_of),
      ) ?? history[0];
    const reasons = filterReasons(document, scope);
    if (reasons.length) filtered.push({ id, reasons });
    else applicable.push(document);
  }
  const tokens = [
    ...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const hits = applicable
    .flatMap((document) =>
      document.chunks.map((chunk, index) => {
        const haystack = chunk.excerpt.toLocaleLowerCase();
        const score = tokens.reduce(
          (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
          0,
        );
        return { document, chunk, index, score };
      }),
    )
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) =>
        authorityWeight[b.document.authority] -
          authorityWeight[a.document.authority] ||
        b.score - a.score ||
        a.document.id.localeCompare(b.document.id) ||
        a.index - b.index,
    )
    .slice(0, topK);
  const docs = [
    ...new Map(hits.map((hit) => [hit.document.id, hit.document])).values(),
  ];
  return {
    query,
    scope: structuredClone(scope),
    evidence: hits.map((hit) => hit.chunk),
    retrieved_doc_refs: docs.map((d) => ({
      id: d.id,
      revision: d.revision,
      version: d.version,
    })),
    filtered,
    // Capture all applicable policy revisions, including non-matching chunks, so top-K cannot hide conflicts.
    policy_documents: applicable.filter((d) => d.kind === 'policy'),
    applicable_documents: applicable,
  };
}
export function resolvePolicy(
  bundle: EvidenceBundle,
  scope: EvidenceScope,
): PolicyResolution {
  if (canonicalJson(bundle.scope) !== canonicalJson(scope))
    throw new EcommerceError(
      'invalid_scope',
      'Policy bundle scope does not match the frozen task scope',
    );
  const candidates = (bundle as RetrievedEvidenceBundle).policy_documents;
  if (!candidates)
    throw new EcommerceError(
      'invalid_request',
      'Policy resolution requires the complete retrieval trace',
    );
  const byPolicy = new Map<string, KnowledgeDocument[]>();
  for (const document of candidates) {
    if (
      filterReasons(document, scope).length ||
      document.authority === 'experience'
    )
      continue;
    byPolicy.set(document.policy_id, [
      ...(byPolicy.get(document.policy_id) ?? []),
      document,
    ]);
  }
  const selected: KnowledgeDocument[] = [],
    conflicts: PolicyConflict[] = [];
  for (const [policyId, documents] of byPolicy) {
    const authority = Math.max(
      ...documents.map((d) => authorityWeight[d.authority]),
    );
    const preferred = documents
      .filter((d) => authorityWeight[d.authority] === authority)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (preferred.length > 1)
      conflicts.push({
        policy_id: policyId,
        document_ids: preferred.map((d) => d.id),
        reason: 'overlapping_effective_versions',
      });
    else selected.push(preferred[0]);
  }
  const refs = selected.map((d) => ({
    id: d.id,
    revision: d.revision,
    version: d.version,
  }));
  const status = conflicts.length
    ? 'conflict'
    : selected.length
      ? 'resolved'
      : 'unknown';
  const snapshotId =
    status === 'resolved'
      ? `policy_${sha256(canonicalJson({ scope, document_refs: refs })).slice(0, 32)}`
      : null;
  const result: PolicyResolution = {
    status,
    policy_snapshot_id: snapshotId,
    conflicts,
    document_refs: refs,
    evidence_refs: selected.flatMap((d) => d.chunks.map((c) => c.evidence_id)),
  };
  if (
    snapshotId &&
    !getObject(scope.workspace_id, 'policy_snapshot', snapshotId)
  )
    putObject(
      scope.workspace_id,
      'policy_snapshot',
      snapshotId,
      { ...result, scope, documents: selected },
      0,
    );
  return result;
}
