import type { TaskResult, Issue } from './contracts.js';
import { canonical, issue, pointer, normalizeFieldPath } from './contracts.js';
import type { Evidence, Product } from './domain.js';
export interface RuleProfile {
  required_facts?: string[];
  required_fields?: string[];
  limits?: Record<
    string,
    {
      max_chars?: number;
      max_bytes?: number;
      min_items?: number;
      max_items?: number;
    }
  >;
  banned_terms?: string[];
  placement?: string;
  version: string;
}
export interface QualityContext {
  products: Product[];
  evidence: Evidence[];
  rules?: RuleProfile[];
}
function strings(
  value: unknown,
  path = '/payload',
): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value))
    return value.flatMap((v, i) => strings(v, path + '/' + i));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      strings(v, path + '/' + k),
    );
  return [];
}
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[_=;:,().]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const measurementPattern = () =>
  /(\d+(?:[.,]\d+)?)\s*(W(?:att(?:s)?)?|V(?:olt(?:s)?)?|kW|mL|L|kg|g|cm|mm|Hz)\b/gi;
const unitKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/^watts?$/, 'w')
    .replace(/^volts?$/, 'v');
const measureKey = (amount: string | number, unit: string) =>
  Number(String(amount).replace(',', '.')) + '|' + unitKey(unit);
export function validateQuality(
  result: TaskResult,
  context: QualityContext,
): Issue[] {
  const issues: Issue[] = [];
  const trusted = new Map(context.evidence.map((e) => [e.evidence_id, e]));
  for (const e of result.evidence)
    if (
      !trusted.has(e.evidence_id) ||
      canonical(trusted.get(e.evidence_id)) !== canonical(e)
    )
      issues.push(
        issue(
          'EVIDENCE_MISMATCH',
          '引用不在冻结上下文中或其内容/hash已改变',
          e.evidence_id,
        ),
      );
  const claimed = new Set<string>();
  for (const c of result.claims) {
    const target = pointer(result, c.field_path);
    if (typeof target !== 'string' || !target.trim())
      issues.push(
        issue('CLAIM_LOCATION', '声明没有指向真实输出字段', c.field_path),
      );
    else {
      claimed.add(normalizeFieldPath(c.field_path));
      if (!normalize(target).includes(normalize(c.text)))
        issues.push(
          issue(
            'CLAIM_LOCATION',
            '声明文本必须指向该字段中真实出现的具体内容',
            c.field_path,
          ),
        );
    }
    const references = c.evidence_refs.map((id) => trusted.get(id));
    if (references.some((e) => !e)) {
      issues.push(
        issue('EVIDENCE_MISSING', '声明引用不存在或未授权', c.field_path),
      );
      continue;
    }
    const claimNumbers = [...c.text.matchAll(/\b\d+(?:[.,]\d+)?\b/g)].map(
      (m) => m[0],
    );
    const corpus = references.map((e) => e!.excerpt).join('\n');
    if (claimNumbers.some((n) => !corpus.includes(n)))
      issues.push(
        issue('UNSUPPORTED_CLAIM', '证据不支持声明中的数值', c.field_path),
      );
    // Numerical anchors and exact quoted statements are deterministic checks.
    // Free semantic claims require explicit evidence, never a URL/confidence alone.
    if (!claimNumbers.length && !normalize(corpus).includes(normalize(c.text)))
      issues.push(
        issue(
          'UNSUPPORTED_CLAIM',
          '非数值声明必须有可核验的支持片段；请补充原文或修改声明',
          c.field_path,
        ),
      );
    if (
      ['listing_pack', 'ad_pack'].includes(result.task_type) &&
      references.some(
        (e) => e!.kind === 'competitor' || e!.kind === 'experience',
      )
    )
      issues.push(
        issue('UNSUPPORTED_CLAIM', '竞品或经验不能证明本品功能', c.field_path),
      );
  }
  if (result.status !== 'draft' || !result.payload) return issues;
  if (
    ['listing_pack', 'ad_pack', 'support_draft'].includes(result.task_type) &&
    context.products.length !== 1
  )
    issues.push(
      issue(
        'SINGLE_PRODUCT_REQUIRED',
        '该草稿必须绑定一个明确SKU，不能混用同市场多个产品规格',
      ),
    );
  const confirmed = context.products
    .filter((p) => p.market === result.market)
    .flatMap((p) =>
      p.facts.filter((f) => f.verification_state === 'confirmed'),
    );
  const material = strings(result.payload).filter(({ path }) =>
    result.task_type === 'listing_pack'
      ? /^\/payload\/(title|bullets\/\d+|description)$/.test(path)
      : result.task_type === 'ad_pack'
        ? /^\/payload\/copies\/\d+\/(headline|body)$/.test(path)
        : result.task_type === 'research_brief'
          ? /^\/payload\/candidates\/\d+\/supported_facts\/\d+$/.test(path)
          : false,
  );
  const neutral = new Set(
    'a an the and or with of for to is are this these that in on at by rated rating product products item items model sku draft internal synthetic demonstration example only not verified real description based source facts fact power voltage electric electrical ein eine eines der die das dem den und oder mit von für ist sind dieses dieser im zu auf nennleistung leistung nennspannung spannung produkt modell entwurf intern synthetisch beispiel us de en w v watt watts volt volts l ml kg g cm mm hz'.split(
      /\s+/,
    ),
  );
  const words = (s: string) => normalize(s).match(/[\p{L}\p{N}]+/gu) ?? [];
  // Every substantive word, not only the numeric claim anchor, needs a source.
  const ownCorpus = context.products
    .map((p) =>
      [
        p.sku,
        p.product_type,
        ...p.facts
          .filter((f) => f.verification_state === 'confirmed')
          .flatMap((f) => [f.field, String(f.value), f.unit ?? '']),
      ].join(' '),
    )
    .join(' ');
  const acceptedCorpus = context.evidence
    .filter(
      (e) =>
        result.task_type === 'research_brief' ||
        e.kind === 'product_fact' ||
        e.kind === 'brand',
    )
    .map((e) => e.excerpt)
    .join(' ');
  const supportedWords = new Set(words(ownCorpus + ' ' + acceptedCorpus));
  const numericalMaterial =
    result.task_type === 'support_draft' &&
    typeof result.payload.reply_body === 'string'
      ? [{ path: '/payload/reply_body', text: result.payload.reply_body }]
      : [];
  for (const { path, text } of numericalMaterial)
    for (const match of text.matchAll(
      /(\d+(?:[.,]\d+)?)\s*(W(?:att(?:s)?)?|V(?:olt(?:s)?)?|kW|mL|L|kg|g|cm|mm|Hz)\b/gi,
    )) {
      const amount = Number(match[1].replace(',', '.')),
        unit = match[2]
          .toLowerCase()
          .replace(/^watts?$/, 'w')
          .replace(/^volts?$/, 'v');
      if (
        !confirmed.some(
          (f) =>
            typeof f.value === 'number' &&
            f.value === amount &&
            (f.unit ?? '').toLowerCase() === unit,
        )
      )
        issues.push(
          issue(
            'UNSUPPORTED_CLAIM',
            '客服规格/单位与当前SKU已确认事实不符',
            path,
          ),
        );
    }
  for (const { path, text } of material) {
    if (!claimed.has(path))
      issues.push(
        issue('UNSUPPORTED_CLAIM', '业务文案缺少字段级声明与证据映射', path),
      );
    const fieldEvidence = result.claims
      .filter((c) => normalizeFieldPath(c.field_path) === path)
      .flatMap((c) => c.evidence_refs)
      .map((id) => trusted.get(id))
      .filter((e): e is Evidence => !!e);
    const referencedNumbers = new Set(
      fieldEvidence.flatMap(
        (e) => e.excerpt.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [],
      ),
    );
    const fieldNumbers = text.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
    if (fieldNumbers.some((number) => !referencedNumbers.has(number)))
      issues.push(
        issue(
          'UNSUPPORTED_CLAIM',
          '字段数值未被该字段所引用的证据支持，不能借用另一候选的数字',
          path,
        ),
      );
    const measures = new Set<string>();
    for (const ev of fieldEvidence) {
      for (const match of ev.excerpt.matchAll(measurementPattern()))
        measures.add(measureKey(match[1], match[2]));
      for (const product of context.products)
        for (const fact of product.facts)
          if (
            fact.evidence_id === ev.evidence_id &&
            typeof fact.value === 'number' &&
            fact.unit &&
            (result.task_type === 'research_brief' ||
              fact.verification_state === 'confirmed')
          )
            measures.add(measureKey(fact.value, fact.unit));
      try {
        const row = JSON.parse(ev.excerpt);
        if (typeof row.value === 'number' && typeof row.unit === 'string')
          measures.add(measureKey(row.value, row.unit));
      } catch {
        /* Plain captured text is handled above. */
      }
    }
    if (
      [...text.matchAll(measurementPattern())].some(
        (m) => !measures.has(measureKey(m[1], m[2])),
      )
    )
      issues.push(
        issue('UNSUPPORTED_CLAIM', '该字段引用没有同时支持数值和单位', path),
      );
    if (
      words(text).some(
        (word) => !neutral.has(word) && !supportedWords.has(word),
      )
    )
      issues.push(
        issue(
          'UNSUPPORTED_CLAIM',
          '字段包含证据和已确认事实未覆盖的描述；请补充依据或移除该表述',
          path,
        ),
      );
    if (result.task_type === 'research_brief') {
      const index = /^\/payload\/candidates\/(\d+)\//.exec(path)?.[1];
      const candidate = pointer(result, '/payload/candidates/' + index) as
        | { candidate_ref?: string }
        | undefined;
      const refs = result.claims
        .filter((c) => normalizeFieldPath(c.field_path) === path)
        .flatMap((c) => c.evidence_refs)
        .map((id) => trusted.get(id))
        .filter((e): e is Evidence => !!e);
      if (
        !candidate?.candidate_ref ||
        !refs.length ||
        refs.some(
          (e) =>
            e.source_id !== candidate.candidate_ref &&
            !context.products.some(
              (p) =>
                p.id === candidate.candidate_ref &&
                p.facts.some((f) => f.evidence_id === e.evidence_id),
            ),
        )
      )
        issues.push(
          issue(
            'CANDIDATE_ATTRIBUTION',
            '候选事实必须引用该候选自身的证据',
            path,
          ),
        );
    }
    for (const match of result.task_type === 'research_brief'
      ? []
      : text.matchAll(
          /(\d+(?:[.,]\d+)?)\s*(W(?:att(?:s)?)?|V(?:olt(?:s)?)?|kW|mL|L|kg|g|cm|mm|Hz)\b/gi,
        )) {
      const amount = Number(match[1].replace(',', '.'));
      const unit = match[2]
        .toLowerCase()
        .replace(/^watts?$/, 'w')
        .replace(/^volts?$/, 'v');
      if (
        !confirmed.some(
          (f) =>
            typeof f.value === 'number' &&
            f.value === amount &&
            (f.unit ?? '').toLowerCase() === unit,
        )
      )
        issues.push(
          issue('UNSUPPORTED_CLAIM', '规格/单位没有本SKU已确认事实支持', path),
        );
    }
    if (
      result.task_type !== 'research_brief' &&
      /\b(certified|certification|CE|UL|FDA|medical|cure|energy.saving)\b|zertifiziert|医疗|认证|节能\d/i.test(
        text,
      )
    ) {
      const own = confirmed
        .filter((f) => /certif|认证|medical|节能/i.test(f.field))
        .map((f) => String(f.value));
      if (!own.some((v) => v && normalize(text).includes(normalize(v))))
        issues.push(
          issue(
            'UNSUPPORTED_CLAIM',
            '认证/功效或性能承诺没有已确认本品依据',
            path,
          ),
        );
    }
  }
  for (const profile of context.rules ?? []) {
    for (const field of profile.required_facts ?? [])
      if (
        context.products.some(
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
        issues.push(
          issue(
            'UNKNOWN_REQUIRED_FACT',
            `适用规则 ${profile.version} 要求已确认事实 ${field}`,
            '/facts/' + field,
          ),
        );
    for (const field of profile.required_fields ?? []) {
      const value = pointer(result, field);
      if (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && !value.length)
      )
        issues.push(issue('REQUIRED_FIELD', '缺少适用规则要求的字段', field));
    }
    for (const [field, limit] of Object.entries(profile.limits ?? {})) {
      const value = pointer(result, field);
      if (
        typeof value === 'string' &&
        ((limit.max_chars !== undefined &&
          [...value].length > limit.max_chars) ||
          (limit.max_bytes !== undefined &&
            Buffer.byteLength(value, 'utf8') > limit.max_bytes))
      )
        issues.push(
          issue('FIELD_LIMIT', `超出规则 ${profile.version} 的字段限制`, field),
        );
      if (
        Array.isArray(value) &&
        ((limit.min_items !== undefined && value.length < limit.min_items) ||
          (limit.max_items !== undefined && value.length > limit.max_items))
      )
        issues.push(
          issue('FIELD_LIMIT', `列表不符合规则 ${profile.version}`, field),
        );
    }
    for (const term of profile.banned_terms ?? [])
      if (
        material.some((v) =>
          v.text.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        )
      )
        issues.push(
          issue(
            'BANNED_EXPRESSION',
            `命中适用规则 ${profile.version} 中的限制表达`,
            null,
          ),
        );
  }
  return issues;
}
