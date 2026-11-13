// Owned-process fixture: process.cwd() must be inside this test's OS temporary root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const [action, baselineFile, extraFile] = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
const relative = path.relative(fs.realpathSync(os.tmpdir()), cwd);
if (
  relative.startsWith('..') ||
  path.isAbsolute(relative) ||
  !relative.split(path.sep)[0].startsWith('opendot-ecommerce-t11-')
)
  throw new Error(
    'Refusing persistence fixture outside its owned temporary cwd',
  );
const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(dist, name)).href);
const file = path.join(cwd, 'data/db/messages.db');
const owner = 't11-owner',
  workspace = 'web:t11';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let active;
let web;

function sourceMetadata(kind = 'product_fact') {
  return {
    kind,
    provenance: 'synthetic',
    owner_scope: workspace,
    market: 'US',
    locale: 'en-US',
    product_refs: [],
    observed_at: '2026-01-01T00:00:00Z',
    known_at: '2026-01-01T00:00:00Z',
    effective_from: kind === 'policy' ? '2026-01-01T00:00:00Z' : null,
    effective_to: null,
    rights_note:
      'Self authored synthetic persistence fixture; no business credentials or real product data.',
  };
}
async function snapshot(db) {
  const repo = await load('ecommerce-ops/repository.js');
  const { getPersonalGoal } = await load('personal-agent/goal-store.js');
  const { hash } = await load('ecommerce-ops/contracts.js');
  const manifest = repo.getObject(workspace, 't11_manifest', 'main')?.body;
  if (!manifest) throw new Error('Business manifest missing');
  const source = repo.readSourceAsset(workspace, manifest.raw_source_id, '1');
  const artifacts = repo.listObjects(workspace, 'artifact').map((row) => ({
    id: row.id,
    revision: row.body.revision,
    content_hash: row.body.content_hash,
    result_hash: hash(row.body.result),
    stale: row.body.stale,
    review_valid: row.body.review?.valid ?? false,
    review_hash: row.body.review?.content_hash ?? null,
  }));
  const goal = getPersonalGoal(owner, manifest.goal_id);
  const reference = repo.getObject(
    workspace,
    'follow_up',
    't11-follow-up',
  )?.body;
  const oldArtifact = repo.getObject(
    workspace,
    'artifact',
    manifest.old_artifact_id,
  )?.body;
  const newArtifact = repo.getObject(
    workspace,
    'artifact',
    manifest.new_artifact_id,
  )?.body;
  const evidence = repo.getEvidence(workspace, manifest.fact_evidence_id);
  const rawHashValid =
    !!source &&
    digest(source.raw) === source.asset.content_hash &&
    source.asset.content_hash === manifest.raw_hash;
  const goalReferenceValid =
    !!goal &&
    goal.workspace_jid === workspace &&
    reference?.goal_id === goal.id &&
    reference.artifact_id === oldArtifact?.id &&
    reference.content_hash === oldArtifact?.content_hash;
  const dependencyReferencesValid =
    !!newArtifact &&
    newArtifact.dependencies.every(
      (dependency) =>
        repo.getObject(workspace, dependency.kind, dependency.id)?.revision ===
        dependency.revision,
    );
  if (
    !rawHashValid ||
    !goalReferenceValid ||
    !dependencyReferencesValid ||
    artifacts.some((value) => value.result_hash !== value.content_hash) ||
    !evidence ||
    !newArtifact?.review?.valid
  )
    throw new Error('Persistence integrity or reference verification failed');
  const stable = {
    manifest,
    product: repo.getObject(workspace, 'product', 't11-product'),
    knowledge: repo.listObjects(workspace, 'knowledge'),
    knowledge_scopes: repo.listObjects(workspace, 'knowledge_scope'),
    task: repo.getObject(workspace, 'task', manifest.task_id),
    attempts: repo.listObjects(workspace, 'task_attempt'),
    artifacts,
    revisions: repo.listObjects(workspace, 'artifact_revision'),
    reviews: repo.listObjects(workspace, 'review_request'),
    goal: {
      id: goal.id,
      workspace_jid: goal.workspace_jid,
      status: goal.status,
      revision: goal.revision,
      budget_max_runs: goal.budget_max_runs,
    },
    reference,
    evidence,
    exports: repo.listObjects(workspace, 'export'),
    raw_hash: source.asset.content_hash,
  };
  return {
    schema: Number(db.getRouterState('schema_version')),
    digest: hash(stable),
    raw_bytes: source.raw.length,
    source_hash_valid: rawHashValid,
    goal_reference_valid: goalReferenceValid,
    dependency_references_valid: dependencyReferencesValid,
    artifacts,
  };
}

async function main() {
  if (action === 'seed107') {
    active = await import(pathToFileURL(baselineFile).href);
    active.initDatabase();
    active.setRouterState('t11-legacy', 'retained by actual v107 entry');
    active.ensureChatExists('web:legacy');
    active.storeMessageDirect(
      'legacy-message',
      'web:legacy',
      'legacy',
      'Synthetic legacy user',
      'Existing v107 conversation survives upgrade',
      '2026-01-01T00:00:00Z',
      false,
    );
    active.closeDatabase();
    active = undefined;
    const probe = new Database(file, { readonly: true });
    try {
      return {
        schema: Number(
          probe
            .prepare(
              "SELECT value FROM router_state WHERE key='schema_version'",
            )
            .get().value,
        ),
        ecommerce_tables: probe
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'ecommerce_%'",
          )
          .get().n,
      };
    } finally {
      probe.close();
    }
  }
  if (action === 'refuse107') {
    const before = digest(fs.readFileSync(file));
    active = await import(pathToFileURL(baselineFile).href);
    let refused = false,
      message = '';
    try {
      active.initDatabase();
    } catch (error) {
      refused = true;
      message = error.message;
    }
    try {
      active.closeDatabase();
    } catch {
      /* init deliberately closes a rejected connection */
    }
    active = undefined;
    return {
      refused,
      message,
      database_unchanged: digest(fs.readFileSync(file)) === before,
    };
  }
  active = await load('db.js');
  active.initDatabase();
  if (action === 'prepare-restore')
    return {
      schema: Number(active.getRouterState('schema_version')),
      private_data_initialized: true,
    };
  if (action === 'migrate108') {
    const schema = Number(active.getRouterState('schema_version'));
    active.closeDatabase();
    active = undefined;
    const probe = new Database(file, { readonly: true });
    let legacyMessage;
    try {
      legacyMessage = probe
        .prepare("SELECT content FROM messages WHERE id='legacy-message'")
        .get().content;
    } finally {
      probe.close();
    }
    const backupDirectory = path.join(cwd, 'data/db/migration-backups');
    const names = fs
      .readdirSync(backupDirectory)
      .filter((name) => name.startsWith('messages-v107-to-v108-'));
    if (names.length !== 1)
      throw new Error('Expected one actual pre-upgrade v107 backup');
    const backup = new Database(path.join(backupDirectory, names[0]), {
      readonly: true,
    });
    const { ensureWindowsPrivateDataDirectory } = await load(
      'windows-private-data.js',
    );
    ensureWindowsPrivateDataDirectory(path.join(cwd, 'data'));
    try {
      return {
        schema,
        legacy_message: legacyMessage,
        backup: {
          schema: Number(
            backup
              .prepare(
                "SELECT value FROM router_state WHERE key='schema_version'",
              )
              .get().value,
          ),
          ecommerce_tables: backup
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'ecommerce_%'",
            )
            .get().n,
          legacy_message: backup
            .prepare("SELECT content FROM messages WHERE id='legacy-message'")
            .get().content,
          quick_check: backup.pragma('quick_check', { simple: true }),
          private_permissions_verified:
            process.platform === 'win32' ||
            (fs.statSync(path.join(backupDirectory, names[0])).mode & 0o077) ===
              0,
          permission_mechanism:
            process.platform === 'win32' ? 'Windows DACL' : 'POSIX mode',
        },
      };
    } finally {
      backup.close();
    }
  }
  if (action === 'seed-business') {
    const repo = await load('ecommerce-ops/repository.js');
    const facts = await load('ecommerce-ops/facts.js');
    const { importAssets } = await load('ecommerce-ops/ingest.js');
    const { ingestKnowledge } = await load('ecommerce-ops/knowledge.js');
    const { createEcommerceWorkflow } = await load('ecommerce-ops/service.js');
    const { reviewArtifact, exportArtifact } = await load(
      'ecommerce-ops/review.js',
    );
    const { emptyUsage } = await load('ecommerce-ops/contracts.js');
    const { createPersonalGoal } = await load('personal-agent/goal-store.js');
    const now = new Date().toISOString();
    active.createUser({
      id: owner,
      username: owner,
      display_name: owner,
      password_hash: 'synthetic-not-a-login-hash',
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    active.setRegisteredGroup(workspace, {
      name: 'Synthetic T11 workspace',
      folder: 't11',
      created_by: owner,
      executionMode: 'container',
      is_home: false,
      added_at: now,
    });
    active.ensureChatExists(workspace);
    active.storeMessageDirect(
      't11-chat',
      workspace,
      owner,
      'Synthetic owner',
      'T11 existing chat remains available',
      now,
      false,
    );
    const imported = await importAssets(
      workspace,
      [
        {
          filename: 'facts.json',
          bytes: Buffer.from(
            JSON.stringify([
              { sku: 'US-T11', field: 'power', value: 1500, unit: 'W' },
            ]),
          ),
          metadata: sourceMetadata(),
        },
      ],
      {},
      't11-first-facts',
    );
    facts.createProduct({
      id: 't11-product',
      workspace_id: workspace,
      sku: 'US-T11',
      market: 'US',
      locale: 'en-US',
      product_type: 'heater',
      seller_scope: 'self',
      facts: imported.rows.map((row) => row.fact),
    });
    facts.confirmFacts(
      workspace,
      't11-product',
      1,
      [
        {
          evidence_id: imported.rows[0].fact.evidence_id,
          decision: 'confirm',
          reason: 'Checked synthetic original',
        },
      ],
      owner,
    );
    const rawBytes = Buffer.from(
      'Synthetic complete manufacturer manual.\n'.repeat(4000),
    );
    const manual = await importAssets(
      workspace,
      [
        {
          filename: 'large-manual.txt',
          bytes: rawBytes,
          metadata: sourceMetadata(),
        },
      ],
      {},
      't11-large-manual',
    );
    const rule = await importAssets(
      workspace,
      [
        {
          filename: 'rules.json',
          bytes: Buffer.from(
            JSON.stringify({
              listing_pack: {
                required_fields: ['/payload/title'],
                limits: { '/payload/title': { max_chars: 200 } },
              },
            }),
          ),
          metadata: sourceMetadata('policy'),
        },
      ],
      {},
      't11-rules',
    );
    ingestKnowledge(workspace, rule.assets[0].source_id, {
      id: 't11-policy',
      product_type: 'heater',
      seller_scope: 'self',
      authority: 'official',
      approval_state: 'approved',
      known_at: '2026-02-01T00:00:00Z',
    });
    const flow = createEcommerceWorkflow(async ({ snapshot }) => {
      const power = snapshot.products[0].facts.find(
        (value) =>
          value.field === 'power' && value.verification_state === 'confirmed',
      );
      const text = `${power.value} W`;
      const result = {
        ...snapshot.bound,
        schema_version: '1.0',
        status: 'draft',
        payload: {
          title: text,
          bullets: [text],
          description: text,
          search_terms: [],
          rule_coverage: 'partial',
          unchecked_rules: [
            'Synthetic fixture, not live marketplace validation',
          ],
        },
        claims: ['title', 'bullets/0', 'description'].map((field) => ({
          claim_id: field,
          text,
          field_path: '/payload/' + field,
          evidence_refs: [power.evidence_id],
        })),
        evidence: snapshot.evidence,
        issues: [],
        usage: emptyUsage(),
      };
      return { text: JSON.stringify(result), usage: emptyUsage() };
    });
    const task = flow.startTask(
      workspace,
      owner,
      {
        task_type: 'listing_pack',
        market: 'US',
        locale: 'en-US',
        product_ids: ['t11-product'],
        as_of: '2026-03-01T00:00:00Z',
      },
      't11-task',
    );
    await flow.resumeTask(workspace, task.id);
    const old = flow.getTask(workspace, task.id).artifact;
    if (!old || old.quality.some((value) => value.severity === 'blocking'))
      throw new Error('Synthetic old artifact failed real quality checks');
    reviewArtifact(
      workspace,
      old.id,
      old.revision,
      old.content_hash,
      'approve',
      'Human checked synthetic original',
      owner,
      'old-review',
    );
    exportArtifact(workspace, old.id, old.revision, 'json', 'approved');
    const next = await importAssets(
      workspace,
      [
        {
          filename: 'revised-facts.json',
          bytes: Buffer.from(
            JSON.stringify([
              { sku: 'US-T11', field: 'power', value: 1800, unit: 'W' },
            ]),
          ),
          metadata: sourceMetadata(),
        },
      ],
      {},
      't11-updated-facts',
    );
    const staged = facts.stageFactCandidates(
      workspace,
      't11-product',
      2,
      next.rows.map((row) => row.fact),
    );
    const updated = facts.confirmFacts(
      workspace,
      't11-product',
      staged.revision,
      [
        {
          evidence_id: imported.rows[0].fact.evidence_id,
          decision: 'reject',
          reason: 'Superseded synthetic specification',
        },
        {
          evidence_id: next.rows[0].fact.evidence_id,
          decision: 'confirm',
          reason: 'Verified revised synthetic specification',
        },
      ],
      owner,
    );
    flow.invalidateDependents(
      workspace,
      'product',
      updated.id,
      updated.revision,
    );
    flow.reopenWithUpdatedInputs(workspace, task.id);
    await flow.resumeTask(workspace, task.id);
    const latest = flow.getTask(workspace, task.id).artifact;
    if (
      !latest ||
      latest.id === old.id ||
      latest.quality.some((value) => value.severity === 'blocking')
    )
      throw new Error(
        'Updated input did not produce a distinct valid artifact',
      );
    reviewArtifact(
      workspace,
      latest.id,
      latest.revision,
      latest.content_hash,
      'approve',
      'Human checked revised synthetic specification',
      owner,
      'new-review',
    );
    exportArtifact(workspace, latest.id, latest.revision, 'json', 'approved');
    const goal = createPersonalGoal(owner, 't11-goal', {
      workspace_jid: workspace,
      objective: 'Manual evidence follow-up',
      completion_criteria: ['Human checks revised specification'],
      next_action: 'Manual review only; no external effect',
      budget_max_runs: 1,
    });
    repo.putObject(
      workspace,
      'follow_up',
      't11-follow-up',
      {
        goal_id: goal.id,
        artifact_id: old.id,
        content_hash: old.content_hash,
        artifact_revision: old.revision,
        execution_mode: 'manual',
        manual_only: true,
        review_required: true,
      },
      0,
    );
    repo.putObject(
      workspace,
      't11_manifest',
      'main',
      {
        task_id: task.id,
        old_artifact_id: old.id,
        new_artifact_id: latest.id,
        goal_id: goal.id,
        fact_evidence_id: next.rows[0].fact.evidence_id,
        raw_source_id: manual.assets[0].source_id,
        raw_hash: digest(rawBytes),
      },
      0,
    );
    return snapshot(active);
  }
  if (action === 'verify-business') return snapshot(active);
  if (action === 'backup') {
    active.closeDatabase();
    active = undefined;
    const destination = path.resolve(extraFile);
    if (!destination.startsWith(path.dirname(cwd) + path.sep))
      throw new Error('Backup destination left owned fixture');
    const connection = new Database(file);
    try {
      connection.prepare('VACUUM INTO ?').run(destination);
    } finally {
      connection.close();
    }
    fs.chmodSync(destination, 0o600);
    const { ensureWindowsPrivateDataDirectory } = await load(
      'windows-private-data.js',
    );
    ensureWindowsPrivateDataDirectory(path.join(cwd, 'data'));
    const restored = new Database(destination, { readonly: true });
    try {
      return {
        quick_check: restored.pragma('quick_check', { simple: true }),
        byte_length: fs.statSync(destination).size,
        private_permissions_verified:
          process.platform === 'win32' ||
          (fs.statSync(destination).mode & 0o077) === 0,
        permission_mechanism:
          process.platform === 'win32' ? 'Windows DACL' : 'POSIX mode',
      };
    } finally {
      restored.close();
    }
  }
  if (action === 'flag-off') {
    const before = await snapshot(active);
    const auth = await load('auth.js');
    const token = auth.generateSessionToken(),
      now = new Date().toISOString();
    active.createUserSession({
      id: token,
      user_id: owner,
      ip_address: null,
      user_agent: 'T11 owned fixture',
      created_at: now,
      last_active_at: now,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    web = await load('web.js');
    const app = web.createAppForTest({
      queue: {},
      getRegisteredGroups: () => active.getAllRegisteredGroups(),
      sessions: {},
      getSessions: () => ({}),
      getLastAgentTimestamp: () => ({}),
      setLastAgentTimestamp: () => {},
      processGroupMessages: async () => false,
      ensureTerminalContainerStarted: () => false,
      formatMessages: () => '',
      advanceCursors: () => {},
      advanceNextPullCursorOnly: () => {},
      advanceGlobalCursor: () => {},
      hasEarlierPendingMessages: () => false,
    });
    const request = (url, method = 'GET', body, authenticated = true) =>
      app.request('http://localhost' + url, {
        method,
        headers: {
          ...(authenticated
            ? { Cookie: 'miniclaw_session=' + auth.signSessionToken(token) }
            : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const responses = {
      auth: await request('/api/auth/me'),
      anonymous_auth: await request('/api/auth/me', 'GET', undefined, false),
      chat: await request(
        '/api/groups/' + encodeURIComponent(workspace) + '/messages',
      ),
      goals: await request('/api/goals'),
      availability: await request('/api/ecommerce-ops/availability'),
      ecommerce_write: await request('/api/ecommerce-ops/products', 'POST', {}),
    };
    const chat = await responses.chat.json(),
      goals = await responses.goals.json(),
      availability = await responses.availability.json();
    const repo = await load('ecommerce-ops/repository.js');
    const manifest = repo.getObject(workspace, 't11_manifest', 'main').body;
    return {
      statuses: Object.fromEntries(
        Object.entries(responses).map(([key, value]) => [key, value.status]),
      ),
      feature_enabled: availability.enabled,
      chat_preserved: chat.messages?.some(
        (value) => value.content === 'T11 existing chat remains available',
      ),
      goal_preserved: goals.goals?.some(
        (value) => value.id === manifest.goal_id,
      ),
      schema: Number(active.getRouterState('schema_version')),
      business_unchanged: (await snapshot(active)).digest === before.digest,
    };
  }
  throw new Error('Unknown owned fixture action');
}

let result, failure;
try {
  result = await main();
} catch (error) {
  failure = error;
} finally {
  try {
    if (web) {
      web.shutdownTerminals();
      await web.shutdownWebServer();
    }
  } catch {
    /* no listener was started */
  }
  try {
    active?.closeDatabase();
  } catch {
    /* rejected old binary already closed */
  }
}
if (failure) {
  process.stderr.write(
    'T11_FAILURE ' + failure.message + '\n' + failure.stack + '\n',
  );
  process.exit(1);
}
process.stdout.write('T11_RESULT ' + JSON.stringify(result) + '\n');
process.exit(0);
