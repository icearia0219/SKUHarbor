import { authMiddleware } from '../middleware/auth.js';
import { getRegisteredGroup, getWorkspaceRecord, getUserById } from '../db.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import { MAX_FILE_SIZE } from '../config.js';
import { getSystemSettings } from '../runtime-config.js';
import { createEcommerceRoutes } from '../ecommerce-ops/routes.js';
import {
  getObject,
  putObject,
  transact,
  listObjects,
} from '../ecommerce-ops/repository.js';
import { hash } from '../ecommerce-ops/contracts.js';
import {
  createPersonalGoal,
  getPersonalGoal,
  listGoalExecutionEvidence,
} from '../personal-agent/goal-store.js';
import { productModelConfiguration } from '../personal-agent/product-model.js';

export function authorizeEcommerceWorkspace(
  workspaceId: string,
  ownerId: string,
  write: boolean,
) {
  const user = getUserById(ownerId),
    workspace = getWorkspaceRecord(workspaceId),
    group = getRegisteredGroup(workspaceId);
  if (
    !user ||
    user.status !== 'active' ||
    user.deleted_at ||
    !workspace ||
    workspace.status !== 'active' ||
    !group ||
    !(write ? canModifyGroup : canAccessGroup)(user, {
      ...group,
      jid: workspaceId,
    })
  )
    throw new Error('NOT_FOUND');
}
export default createEcommerceRoutes({
  auth: authMiddleware,
  authorize: authorizeEcommerceWorkspace,
  maxFileBytes: MAX_FILE_SIZE,
  maxElapsedMs: () => getSystemSettings().containerTimeout,
  modelStatus(workspaceId) {
    try {
      productModelConfiguration(workspaceId, undefined, {
        allowContainerWorkspace: true,
      });
      return 'configured_unprobed';
    } catch {
      return 'not_configured';
    }
  },
  async followUp(input) {
    if (process.env.MINICLAW_PERSONAL_GOALS?.toLowerCase() !== 'true')
      throw new Error('GOAL_FEATURE_DISABLED');
    if (
      Date.parse(input.due_at) <= Date.now() ||
      Date.parse(input.due_at) > Date.now() + 90 * 86400000
    )
      throw new Error('INVALID_DUE_DATE');
    return transact(() => {
      const key =
        'ecommerce:' +
        hash([input.workspace_id, input.artifact.id, input.request_key]);
      const digest = hash([
        input.artifact.revision,
        input.artifact.content_hash,
        input.criteria,
        input.due_at,
      ]);
      const old = getObject<{ digest: string; goal_id: string }>(
        input.workspace_id,
        'follow_up',
        key,
      );
      if (old) {
        if (old.body.digest !== digest) throw new Error('IDEMPOTENCY_CONFLICT');
        return old.body;
      }
      // Manual bounded Goal: no new Scheduler or unattended external effects.
      const goal = createPersonalGoal(input.owner_id, key, {
        workspace_jid: input.workspace_id,
        objective: `核验电商草稿 ${input.artifact.id} r${input.artifact.revision}`,
        completion_criteria: input.criteria,
        next_action: `截止 ${input.due_at} 前补充可定位证据；原稿hash ${input.artifact.content_hash}。人工核验，不自动批准/发布。`,
        budget_max_runs: 1,
      });
      const link = {
        id: key,
        goal_id: goal.id,
        workspace_id: input.workspace_id,
        artifact_id: input.artifact.id,
        artifact_revision: input.artifact.revision,
        content_hash: input.artifact.content_hash,
        due_at: input.due_at,
        criteria: input.criteria,
        digest,
        observed_goal_revision: goal.revision,
        goal_status: goal.status,
        verified_evidence: [],
        review_required: true,
        execution_mode: 'manual',
        manual_only: true,
      };
      putObject(input.workspace_id, 'follow_up', key, link, 0);
      return link;
    });
  },
  async refreshFollowUp(workspaceId, ownerId, goalId) {
    authorizeEcommerceWorkspace(workspaceId, ownerId, true);
    return transact(() => {
      const goal = getPersonalGoal(ownerId, goalId);
      if (!goal || goal.workspace_jid !== workspaceId)
        throw new Error('NOT_FOUND');
      const row = listObjects<Record<string, unknown>>(
        workspaceId,
        'follow_up',
      ).find((r) => r.body.goal_id === goalId);
      if (!row) throw new Error('NOT_FOUND');
      if (row.body.observed_goal_revision === goal.revision) return row.body;
      const updated = {
        ...row.body,
        observed_goal_revision: goal.revision,
        goal_status: goal.status,
        verified_evidence: listGoalExecutionEvidence(ownerId, goalId),
        review_required: true,
      };
      putObject(workspaceId, 'follow_up', row.id, updated, row.revision);
      return updated;
    });
  },
});
