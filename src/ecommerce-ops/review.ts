import type { Artifact } from './workflow.js';
import type { Issue, BoundTaskContext, TaskResult } from './contracts.js';
import { getObject, putObject, transact } from './repository.js';
import { hash, validateTaskResult } from './contracts.js';
const read = (ws: string, id: string) => {
  const row = getObject<Artifact>(ws, 'artifact', id);
  if (!row) throw new Error('NOT_FOUND');
  return row;
};
const current = (a: Artifact) =>
  !a.stale &&
  a.dependencies.every(
    (d) => getObject(a.workspace_id, d.kind, d.id)?.revision === d.revision,
  );
export function reviewArtifact(
  workspaceId: string,
  id: string,
  expectedRevision: number,
  contentHash: string,
  decision: 'approve' | 'reject',
  reason: string,
  reviewer: string,
  requestKey: string,
): Artifact {
  if (
    !['approve', 'reject'].includes(decision) ||
    !reason.trim() ||
    !requestKey.trim() ||
    !reviewer
  )
    throw new Error('INVALID_REVIEW');
  return transact(() => {
    const row = read(workspaceId, id),
      a = row.body;
    const reviewId = hash([id, reviewer, requestKey]),
      digest = hash([expectedRevision, contentHash, decision, reason]);
    const old = getObject<{ digest: string }>(
      workspaceId,
      'review_request',
      reviewId,
    );
    if (
      a.revision !== expectedRevision ||
      a.content_hash !== contentHash ||
      hash(a.result) !== contentHash
    )
      throw new Error('REVISION_CONFLICT');
    if (old) {
      if (old.body.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT');
      return a;
    }
    const schema = validateTaskResult(a.result, a.result as BoundTaskContext);
    if (
      decision === 'approve' &&
      (!schema.ok ||
        !current(a) ||
        a.result.status !== 'draft' ||
        !a.result.payload ||
        [...a.quality, ...a.result.issues].some(
          (i) => i.severity === 'blocking',
        ))
    )
      throw new Error('REVIEW_BLOCKED');
    const updated: Artifact = {
      ...a,
      review: {
        decision,
        reviewer,
        reason,
        revision: a.revision,
        content_hash: contentHash,
        valid: decision === 'approve',
        request_key: requestKey,
        created_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };
    putObject(workspaceId, 'artifact', id, updated, row.revision);
    putObject(
      workspaceId,
      'review_request',
      reviewId,
      {
        digest,
        decision,
        reason,
        reviewer,
        artifact_id: id,
        artifact_revision: a.revision,
        content_hash: contentHash,
      },
      0,
    );
    return updated;
  });
}
export function editArtifact(
  workspaceId: string,
  id: string,
  expectedRevision: number,
  payload: Record<string, unknown>,
  quality: (result: TaskResult) => Issue[],
): Artifact {
  return transact(() => {
    const row = read(workspaceId, id),
      a = row.body;
    if (a.revision !== expectedRevision) throw new Error('REVISION_CONFLICT');
    const result = { ...a.result, payload, status: 'draft' as const };
    const checked = validateTaskResult(result, result);
    if (!checked.ok) throw new Error('INVALID_ARTIFACT_SCHEMA');
    const previousId = id + ':' + a.revision;
    if (!getObject(workspaceId, 'artifact_revision', previousId))
      putObject(workspaceId, 'artifact_revision', previousId, a, 0);
    const updated = {
      ...a,
      result,
      content_hash: hash(result),
      revision: a.revision + 1,
      quality: quality(result),
      review: null,
      updated_at: new Date().toISOString(),
    };
    putObject(workspaceId, 'artifact', id, updated, row.revision);
    return updated;
  });
}
function csvCell(v: unknown): string {
  let text = v === null ? '' : String(v);
  if (/^[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function exportArtifact(
  workspaceId: string,
  id: string,
  revision: number,
  format: 'json' | 'markdown' | 'csv',
  mode: 'preview' | 'approved',
): { content: string; mime: string; filename: string } {
  return transact(() => {
    const a = read(workspaceId, id).body;
    if (a.revision !== revision) throw new Error('REVISION_CONFLICT');
    const approved =
      current(a) &&
      a.review?.valid &&
      a.review.decision === 'approve' &&
      a.review.revision === a.revision &&
      a.review.content_hash === a.content_hash &&
      hash(a.result) === a.content_hash;
    if (mode === 'approved' && !approved) throw new Error('APPROVAL_REQUIRED');
    if (
      !['json', 'markdown', 'csv'].includes(format) ||
      !['preview', 'approved'].includes(mode)
    )
      throw new Error('INVALID_EXPORT');
    const delivery_status =
      mode === 'approved'
        ? 'approved_internal_package'
        : a.stale
          ? 'stale_preview'
          : 'unreviewed_preview';
    const model = {
      artifact_id: id,
      revision: a.revision,
      content_hash: a.content_hash,
      delivery_status,
      notice: '内部人工审核包，不是 Amazon 上传 payload，不执行任何平台写入。',
      result: a.result,
      quality: a.quality,
      review: a.review,
    };
    let content: string, mime: string, extension: string;
    if (format === 'json') {
      content = JSON.stringify(model, null, 2);
      mime = 'application/json';
      extension = 'json';
    } else if (format === 'markdown') {
      content = `# ${a.result.task_type}\n\n状态：${delivery_status}\n\n${model.notice}\n\n\`\`\`json\n${JSON.stringify(model, null, 2)}\n\`\`\`\n`;
      mime = 'text/markdown; charset=utf-8';
      extension = 'md';
    } else {
      if (a.result.task_type !== 'ads_diagnosis' || !a.result.payload?.metrics)
        throw new Error('CSV_ONLY_FOR_METRICS');
      const metrics = a.result.payload.metrics as Record<string, unknown>;
      content =
        'delivery_status,artifact_id,revision,metric,value,unit\r\n' +
        Object.entries(metrics)
          .map(([key, value]) =>
            [
              delivery_status,
              id,
              revision,
              key,
              value,
              key.endsWith('_minor')
                ? 'minor_unit'
                : key.includes('ratio') || key === 'roas'
                  ? 'ratio'
                  : key === 'currency'
                    ? 'currency'
                    : 'count',
            ]
              .map(csvCell)
              .join(','),
          )
          .join('\r\n');
      mime = 'text/csv; charset=utf-8';
      extension = 'csv';
    }
    const exportId = hash([id, revision, format, mode, hash(model)]);
    if (!getObject(workspaceId, 'export', exportId))
      putObject(
        workspaceId,
        'export',
        exportId,
        {
          id: exportId,
          artifact_id: id,
          revision,
          format,
          mode,
          content_hash: hash(content),
          content,
          mime,
        },
        0,
      );
    return {
      content,
      mime,
      filename: `${id}-r${revision}-${mode}.${extension}`,
    };
  });
}
