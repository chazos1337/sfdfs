import type {
  Action,
  Agent,
  AllowlistEntry,
  Crate,
  FeedItem,
  HumanTask,
  McpToolRow,
  Opportunity,
  Run,
  RunEvent,
  RunEventType,
  Settings,
  Stage,
} from '@mf/shared';
import { bus } from '../bus';
import { config } from '../config';
import { audit } from '../safety/audit';
import { db, json, now, today } from './db';

// ---------------------------------------------------------------- helpers

function update(table: string, id: number, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`;
  const params: Record<string, unknown> = { __id: id };
  for (const k of keys) {
    const v = patch[k];
    params[k] = typeof v === 'boolean' ? Number(v) : v;
  }
  db.prepare(sql).run(params);
}

function insert(table: string, row: Record<string, unknown>): number {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`;
  return Number(db.prepare(sql).run(row).lastInsertRowid);
}

// ---------------------------------------------------------------- settings

export function defaultSettings(): Settings {
  return {
    profile: {
      summary:
        'Starting from scratch with little to no capital. Open to any kind of work; wants ideas that can start for free and grow as they prove themselves.',
      skills: [],
      hours_per_week: 10,
      starting_capital_usd: 0,
      risk_tolerance: 'medium',
      notes: '',
    },
    worker_count: config.WORKER_COUNT,
    auto_mode: false,
    paused: false,
    kill_switch: false,
    daily_api_budget_usd: config.DAILY_API_BUDGET_USD,
    per_run_budget_usd: config.PER_RUN_BUDGET_USD,
    per_action_cap_usd: config.PER_ACTION_CAP_USD,
    daily_spend_cap_usd: config.DAILY_SPEND_CAP_USD,
    daily_email_cap: config.DAILY_EMAIL_CAP,
    vault_threshold: 60,
    score_weights: {
      startup_cost: 20,
      time_to_first_dollar: 20,
      skill_fit: 15,
      risk: 20,
      scalability: 20,
      legality: 5,
    },
    scout_interval_min: 30,
    scout_batch: 3,
    ntfy_url: config.NTFY_URL,
    muted: false,
  };
}

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const s = defaultSettings() as unknown as Record<string, unknown>;
  for (const r of rows) if (r.key in s) s[r.key] = json(r.value, s[r.key]);
  return s as unknown as Settings;
}

export function updateSettings(patch: Partial<Settings>, actor = 'user'): Settings {
  const before = getSettings() as unknown as Record<string, unknown>;
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const stmt = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in before) || v === undefined) continue;
    if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
    stmt.run(k, JSON.stringify(v), now());
    changed[k] = { from: before[k], to: v };
  }
  const after = getSettings();
  if (Object.keys(changed).length) {
    audit(actor, 'setting_change', null, changed);
    bus.publish({ type: 'settings.updated', data: after });
  }
  return after;
}

/** Small key/value cache for things like the last wallet balance. */
export function getKv<T>(key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('kv:' + key) as { value: string } | undefined;
  return json(r?.value, fallback);
}
export function setKv(key: string, value: unknown) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run('kv:' + key, JSON.stringify(value), now());
}

// ---------------------------------------------------------------- feed

export function feed(level: FeedItem['level'], text: string, ref: string | null = null) {
  const item: Omit<FeedItem, 'id'> = { ts: now(), level, text, ref };
  const id = insert('feed', item);
  bus.publish({ type: 'feed.event', data: { id, ...item } });
}

export function listFeed(limit = 100): FeedItem[] {
  return (db.prepare('SELECT * FROM feed ORDER BY id DESC LIMIT ?').all(limit) as FeedItem[]).reverse();
}

// ---------------------------------------------------------------- agents

const NAMES = ['Bolt', 'Pip', 'Rivet', 'Sprocket', 'Nib', 'Cog', 'Tally', 'Widget', 'Gizmo', 'Ledger', 'Penny', 'Flint'];
const PALETTES = ['#4f9dff', '#ff7a59', '#7bd88f', '#c792ea', '#ffd166', '#5ad1d1', '#ff6fb5', '#a3be8c', '#f78c6c', '#82aaff', '#e6c07b', '#89ddff'];

export function ensureAgents(count: number) {
  const existing = (db.prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n;
  for (let i = existing; i < count; i++) {
    const id = insert('agents', {
      name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''),
      palette: PALETTES[i % PALETTES.length],
      created_at: now(),
    });
    bus.publish({ type: 'agent.updated', data: getAgent(id)! });
  }
}

export function listAgents(): Agent[] {
  return db.prepare('SELECT * FROM agents ORDER BY id').all() as Agent[];
}
export function getAgent(id: number): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}
export function updateAgent(id: number, patch: Partial<Agent>) {
  update('agents', id, patch);
  bus.publish({ type: 'agent.updated', data: getAgent(id)! });
}

// ---------------------------------------------------------------- crates

export function createCrate(c: {
  title: string;
  body?: string | null;
  source: Crate['source'];
  priority?: number;
  origin_agent_id?: number | null;
}): Crate {
  const id = insert('crates', {
    title: c.title.slice(0, 200),
    body: c.body ?? null,
    source: c.source,
    priority: c.priority ?? 0,
    stage: 'dock',
    status: 'queued',
    origin_agent_id: c.origin_agent_id ?? null,
    created_at: now(),
    updated_at: now(),
  });
  const crate = getCrate(id)!;
  bus.publish({ type: 'crate.updated', data: crate });
  return crate;
}

export function getCrate(id: number): Crate | undefined {
  return db.prepare('SELECT * FROM crates WHERE id = ?').get(id) as Crate | undefined;
}

export function updateCrate(id: number, patch: Partial<Crate>) {
  update('crates', id, { ...patch, updated_at: now() });
  bus.publish({ type: 'crate.updated', data: getCrate(id)! });
}

/** Active crates plus the most recent finished ones, for the snapshot. */
export function listCrates(limitDone = 150): Crate[] {
  return db
    .prepare(
      `SELECT * FROM crates WHERE status NOT IN ('done') OR stage NOT IN ('vault','scrap')
       UNION SELECT * FROM (SELECT * FROM crates WHERE status = 'done' AND stage IN ('vault','scrap') ORDER BY updated_at DESC LIMIT ?)
       ORDER BY id`,
    )
    .all(limitDone) as Crate[];
}

export function cratesAt(stage: Stage): Crate[] {
  return db
    .prepare('SELECT * FROM crates WHERE stage = ? ORDER BY priority DESC, created_at LIMIT 200')
    .all(stage) as Crate[];
}

// ---------------------------------------------------------------- runs

export function createRun(r: {
  agent_id: number;
  crate_id?: number | null;
  opportunity_id?: number | null;
  role: Run['role'];
  model: string;
  prompt_version: string;
}): Run {
  const id = insert('runs', {
    agent_id: r.agent_id,
    crate_id: r.crate_id ?? null,
    opportunity_id: r.opportunity_id ?? null,
    role: r.role,
    model: r.model,
    prompt_version: r.prompt_version,
    status: 'running',
    started_at: now(),
  });
  const run = getRun(id)!;
  bus.publish({ type: 'run.started', data: run });
  return run;
}

export function getRun(id: number): Run | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
}

export function updateRun(id: number, patch: Partial<Run> & { session_id?: string; cache_read_tokens?: number; cache_write_tokens?: number }) {
  update('runs', id, patch);
  const run = getRun(id)!;
  if (patch.status && patch.status !== 'running') bus.publish({ type: 'run.finished', data: run });
}

export function addRunEvent(runId: number, type: RunEventType, payload: unknown): RunEvent {
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?').get(runId) as {
    seq: number;
  };
  let text = JSON.stringify(payload ?? null);
  if (text.length > 200_000) text = JSON.stringify({ truncated: true, head: text.slice(0, 200_000) });
  const ev = { run_id: runId, seq: seqRow.seq, ts: now(), type, payload: text };
  insert('run_events', ev);
  const out: RunEvent = { ...ev, payload: JSON.parse(text) };
  bus.publish({ type: 'run.event', data: out });
  return out;
}

export function listRunEvents(runId: number): RunEvent[] {
  return (db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Array<RunEvent & { payload: string }>).map(
    (e) => ({ ...e, payload: json(e.payload as string, null) }),
  );
}

export function runsForCrate(crateId: number): Run[] {
  return db.prepare('SELECT * FROM runs WHERE crate_id = ? ORDER BY id').all(crateId) as Run[];
}

export function runsForOpportunity(oppId: number): Run[] {
  return db.prepare('SELECT * FROM runs WHERE opportunity_id = ? ORDER BY id').all(oppId) as Run[];
}

// ---------------------------------------------------------------- stage results & sources

export function saveStageResult(crateId: number, stage: string, runId: number, result: unknown) {
  insert('stage_results', { crate_id: crateId, stage, run_id: runId, result_json: JSON.stringify(result), created_at: now() });
}

export function stageResults(crateId: number): Record<string, unknown> {
  const rows = db
    .prepare('SELECT stage, result_json FROM stage_results WHERE crate_id = ? ORDER BY id')
    .all(crateId) as Array<{ stage: string; result_json: string }>;
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.stage] = json(r.result_json, null);
  return out;
}

export function addSources(runId: number, crateId: number | null, sources: Array<{ url: string; title?: string; claim?: string }>) {
  const stmt = db.prepare('INSERT INTO sources (run_id, crate_id, url, title, claim, accessed_at) VALUES (?,?,?,?,?,?)');
  for (const s of sources) stmt.run(runId, crateId, s.url, s.title ?? null, s.claim ?? null, now());
}

export function sourcesForRun(runId: number) {
  return db.prepare('SELECT * FROM sources WHERE run_id = ? ORDER BY id').all(runId);
}

export function sourcesForCrate(crateId: number) {
  return db.prepare('SELECT * FROM sources WHERE crate_id = ? ORDER BY id').all(crateId);
}

// ---------------------------------------------------------------- opportunities

export function createOpportunity(o: Omit<Opportunity, 'id' | 'created_at' | 'status' | 'mode' | 'promoted_at' | 'frozen_reason' | 'step_state_json'>): Opportunity {
  const id = insert('opportunities', { ...o, created_at: now() });
  const opp = getOpportunity(id)!;
  bus.publish({ type: 'opportunity.updated', data: opp });
  return opp;
}

export function getOpportunity(id: number): Opportunity | undefined {
  return db.prepare('SELECT * FROM opportunities WHERE id = ?').get(id) as Opportunity | undefined;
}

export function updateOpportunity(id: number, patch: Partial<Opportunity>) {
  update('opportunities', id, patch);
  bus.publish({ type: 'opportunity.updated', data: getOpportunity(id)! });
}

export function listOpportunities(): Opportunity[] {
  return db.prepare('SELECT * FROM opportunities ORDER BY score DESC').all() as Opportunity[];
}

// ---------------------------------------------------------------- actions

export function createAction(a: Omit<Action, 'id' | 'created_at' | 'decided_at' | 'executed_at'>): Action {
  const id = insert('actions', { ...a, created_at: now() });
  const action = getAction(id)!;
  bus.publish({ type: action.status === 'pending_approval' ? 'approval.updated' : 'action.recorded', data: action });
  return action;
}

export function getAction(id: number): Action | undefined {
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Action | undefined;
}

export function updateAction(id: number, patch: Partial<Action> & { external_request_id?: string }) {
  update('actions', id, patch);
  const a = getAction(id)!;
  bus.publish({ type: 'approval.updated', data: a });
}

export function pendingApprovals(): Action[] {
  return db.prepare("SELECT * FROM actions WHERE status = 'pending_approval' ORDER BY id").all() as Action[];
}

export function listActions(opts: { opportunity_id?: number; limit?: number } = {}): Action[] {
  if (opts.opportunity_id)
    return db.prepare('SELECT * FROM actions WHERE opportunity_id = ? ORDER BY id DESC LIMIT ?').all(opts.opportunity_id, opts.limit ?? 200) as Action[];
  return db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?').all(opts.limit ?? 200) as Action[];
}

/** Has the owner ever approved (or successfully run) this kind of action? */
export function actionTypeSeen(server: string, tool: string, mode: string): boolean {
  const r = db
    .prepare(
      `SELECT 1 FROM actions WHERE server = ? AND tool = ? AND mode = ? AND tier >= 1
       AND (status = 'approved' OR (status IN ('executed','simulated') AND decided_at IS NOT NULL)) LIMIT 1`,
    )
    .get(server, tool, mode);
  return !!r;
}

/** Emails sent (or simulated) in the last 24 hours. */
export function emailsSentRecently(mode: string): number {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const r = db
    .prepare(
      `SELECT COUNT(*) n FROM actions WHERE mode = ? AND status IN ('executed','simulated','approved')
       AND tool IN (SELECT tool FROM mcp_tools WHERE classifier = 'email_send') AND created_at >= ?`,
    )
    .get(mode, since) as { n: number };
  return r.n;
}

// ---------------------------------------------------------------- allowlist

export function listAllowlist(): AllowlistEntry[] {
  return db.prepare('SELECT * FROM allowlist ORDER BY kind, value').all() as AllowlistEntry[];
}

export function addAllowlist(e: { kind: AllowlistEntry['kind']; value: string; chain?: string | null; label?: string | null }, actor = 'user') {
  const value = e.kind.startsWith('email') || e.kind === 'x402_host' || e.kind === 'merchant' ? e.value.trim().toLowerCase() : e.value.trim();
  const id = insert('allowlist', { kind: e.kind, value, chain: e.chain ?? null, label: e.label ?? null, added_at: now() });
  audit(actor, 'allowlist_add', String(id), { ...e, value });
  return id;
}

export function removeAllowlist(id: number, actor = 'user') {
  const row = db.prepare('SELECT * FROM allowlist WHERE id = ?').get(id);
  db.prepare('DELETE FROM allowlist WHERE id = ?').run(id);
  audit(actor, 'allowlist_remove', String(id), row);
}

export function isAllowlisted(kind: AllowlistEntry['kind'], value: string, chain?: string | null): boolean {
  const v = kind === 'wallet_address' || kind === 'contract' ? value.trim() : value.trim().toLowerCase();
  const rows = db.prepare('SELECT value, chain FROM allowlist WHERE kind = ?').all(kind) as Array<{ value: string; chain: string | null }>;
  return rows.some((r) => {
    const same = kind === 'wallet_address' || kind === 'contract' ? sameAddress(r.value, v) : r.value === v;
    return same && (!r.chain || !chain || r.chain === chain);
  });
}

function sameAddress(a: string, b: string) {
  // EVM addresses are case-insensitive; Solana (base58) addresses are not.
  return a.startsWith('0x') && b.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------- mcp tools

export function upsertTool(t: {
  server: string;
  tool: string;
  description: string | null;
  input_schema: string;
  schema_hash: string;
  tier: number;
  classifier: string | null;
}) {
  const existing = db.prepare('SELECT * FROM mcp_tools WHERE server = ? AND tool = ?').get(t.server, t.tool) as
    | (McpToolRow & { schema_hash: string })
    | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO mcp_tools (server, tool, description, input_schema, tier, classifier, reviewed, first_seen, schema_hash) VALUES (?,?,?,?,?,?,0,?,?)',
    ).run(t.server, t.tool, t.description, t.input_schema, t.tier, t.classifier, now(), t.schema_hash);
    return 'new';
  }
  if (existing.schema_hash !== t.schema_hash) {
    // Schema changed under us: block until the owner reviews it again.
    db.prepare('UPDATE mcp_tools SET description = ?, input_schema = ?, schema_hash = ?, tier = 3, reviewed = 0 WHERE server = ? AND tool = ?').run(
      t.description,
      t.input_schema,
      t.schema_hash,
      t.server,
      t.tool,
    );
    audit('system', 'tool_schema_changed', `${t.server}/${t.tool}`, { previous_tier: existing.tier });
    return 'changed';
  }
  return 'same';
}

export function listTools(): Array<McpToolRow & { input_schema: string }> {
  return db.prepare('SELECT * FROM mcp_tools ORDER BY server, tier, tool').all() as Array<McpToolRow & { input_schema: string }>;
}

export function getTool(server: string, tool: string) {
  return db.prepare('SELECT * FROM mcp_tools WHERE server = ? AND tool = ?').get(server, tool) as
    | (McpToolRow & { input_schema: string })
    | undefined;
}

export function setToolTier(server: string, tool: string, tier: number, reviewed: boolean, actor = 'user') {
  const before = getTool(server, tool);
  db.prepare('UPDATE mcp_tools SET tier = ?, reviewed = ? WHERE server = ? AND tool = ?').run(tier, Number(reviewed), server, tool);
  audit(actor, 'tool_tier_change', `${server}/${tool}`, { from: before?.tier, to: tier, reviewed });
}

// ---------------------------------------------------------------- human tasks

export function addHumanTask(opportunityId: number, stepId: string | null, text: string) {
  const dup = db.prepare("SELECT 1 FROM human_tasks WHERE opportunity_id = ? AND text = ? AND status = 'open'").get(opportunityId, text);
  if (dup) return;
  insert('human_tasks', { opportunity_id: opportunityId, step_id: stepId, text, created_at: now() });
}

export function listHumanTasks(opportunityId?: number): HumanTask[] {
  if (opportunityId) return db.prepare('SELECT * FROM human_tasks WHERE opportunity_id = ? ORDER BY id').all(opportunityId) as HumanTask[];
  return db.prepare("SELECT * FROM human_tasks WHERE status = 'open' ORDER BY id").all() as HumanTask[];
}

export function completeHumanTask(id: number) {
  db.prepare("UPDATE human_tasks SET status = 'done', done_at = ? WHERE id = ?").run(now(), id);
  audit('user', 'human_task_done', String(id), null);
}

// ---------------------------------------------------------------- money

export function addLedger(kind: 'api' | 'wallet' | 'wallet_paper', amount: number, ref: string) {
  insert('spend_ledger', { ts: now(), day: today(), kind, amount_usd: amount, ref });
}

export function spentToday(kind: 'api' | 'wallet' | 'wallet_paper'): number {
  const r = db.prepare('SELECT COALESCE(SUM(amount_usd), 0) s FROM spend_ledger WHERE day = ? AND kind = ?').get(today(), kind) as {
    s: number;
  };
  return r.s;
}

export function addPnl(e: { opportunity_id: number; amount_usd: number; kind: string; source: string; mode: string; note?: string }) {
  insert('pnl_entries', { ...e, note: e.note ?? null, ts: now() });
}

export function pnlByOpportunity(): Array<{ opportunity_id: number; title: string; mode: 'paper' | 'live'; total_usd: number }> {
  return db
    .prepare(
      `SELECT p.opportunity_id, o.title, p.mode, SUM(p.amount_usd) total_usd
       FROM pnl_entries p JOIN opportunities o ON o.id = p.opportunity_id
       GROUP BY p.opportunity_id, p.mode ORDER BY total_usd DESC`,
    )
    .all() as Array<{ opportunity_id: number; title: string; mode: 'paper' | 'live'; total_usd: number }>;
}

export function realizedLiveRevenue(): number {
  const r = db.prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM pnl_entries WHERE mode = 'live' AND kind = 'revenue'").get() as { s: number };
  return r.s;
}

export function realizedLivePnl(): number {
  const r = db.prepare("SELECT COALESCE(SUM(amount_usd),0) s FROM pnl_entries WHERE mode = 'live'").get() as { s: number };
  return r.s;
}
