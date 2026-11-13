/** Shared business contracts. Evidence is exactly task-result.schema.json/$defs/evidence. */
export type Market = 'US' | 'DE';
export type Locale = 'en-US' | 'de-DE';
export type TaskType =
  | 'research_brief'
  | 'listing_pack'
  | 'ad_pack'
  | 'ads_diagnosis'
  | 'support_draft';
export type EvidenceKind =
  | 'product_fact'
  | 'policy'
  | 'brand'
  | 'competitor'
  | 'report'
  | 'order'
  | 'ticket'
  | 'experience';
export type Provenance = 'real' | 'redacted' | 'synthetic' | 'public';
export interface Evidence {
  evidence_id: string;
  source_id: string;
  kind: EvidenceKind;
  locator: string;
  content_hash: string;
  provenance: Provenance;
  excerpt: string;
}
export interface ProductRef {
  product_id: string;
  sku: string;
  revision: string;
  market: Market;
}
export interface ProductFact {
  field: string;
  value: string | number | boolean | null;
  unit: string | null;
  evidence_id: string;
  verification_state: 'candidate' | 'confirmed' | 'rejected';
}
export interface Product {
  id: string;
  workspace_id: string;
  sku: string;
  market: Market;
  locale: Locale;
  product_type: string;
  seller_scope: string;
  revision: number;
  facts: ProductFact[];
}
export interface SourceAsset {
  workspace_id: string;
  source_id: string;
  kind: EvidenceKind;
  provenance: Provenance;
  owner_scope: string;
  market: Market;
  locale: Locale;
  product_refs: ProductRef[];
  observed_at: string;
  effective_from: string | null;
  effective_to: string | null;
  known_at: string;
  version: string;
  content_hash: string;
  rights_note: string;
  ingestion_status: 'ready' | 'failed';
  filename: string;
  media_type: string;
  byte_length: number;
  source_url: string | null;
}
export interface KnowledgeRevision {
  id: string;
  workspace_id: string;
  revision: number;
  asset_id: string;
  asset_version: string;
  market: Market;
  locale: Locale;
  product_type: string;
  seller_scope: string;
  product_refs: ProductRef[];
  kind: EvidenceKind;
  authority: 'official' | 'manufacturer' | 'merchant' | 'experience';
  approval_state: 'pending' | 'approved' | 'withdrawn';
  effective_from: string | null;
  effective_to: string | null;
  known_at: string;
  version: string;
  chunks: Evidence[];
}
export interface EvidenceScope {
  workspace_id: string;
  market: Market;
  locale?: Locale;
  product_type: string;
  seller_scope: string;
  product_refs?: ProductRef[];
  as_of: string;
  known_as_of: string;
}
export interface EvidenceBundle {
  query: string;
  scope: EvidenceScope;
  evidence: Evidence[];
  retrieved_doc_refs: Array<{ id: string; revision: number; version: string }>;
  filtered: Array<{ id: string; reasons: string[] }>;
}
/** All service callers must authorize workspace access before supplying this ID. */
export interface ObjectRecord<T> {
  id: string;
  revision: number;
  body: T;
  created_at: string;
  updated_at: string;
}
