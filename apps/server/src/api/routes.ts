import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Settings, Stage } from '@mf/shared';
import { z } from 'zod';
import { config } from '../config';
import { db, now } from '../db/db';
import {
  addAllowlist,
  addPnl,
  completeHumanTask,
  createCrate,
  cratesAt,
  feed,
  getAction,
  getAgent,
  getCrate,
  getOpportunity,
  getRun,
  getSettings,
  listActions,
  listAllowlist,
  listHumanTasks,
  listRunEvents,
  listTools,
  removeAllowlist,
  runsForCrate,
  runsForOpportunity,
  setToolTier,
  sourcesForCrate,
  sourcesForRun,
  stageResults,
  updateCrate,
  updateOpportunity,
  updateSettings,
} from '../db/repo';
import { approve, ApprovalError, reject } from '../execution/approvals';
import { connectAll, upstreamStatus } from '../execution/mcpClients';
import { maxPerActionCap, maxWorkers } from '../game/upgrades';
import { planOf, setStepState, statesOf } from '../pipeline/steps';
import { tick } from '../pipeline/scheduler';
import { audit, listAudit, verifyAudit } from '../safety/audit';
import { publishBudget, resetClockOutIfFunded } from '../safety/budget';
import { engageKillSwitch, rearm } from '../safety/killSwitch';
import { snapshot } from '../snapshot';

function bad(reply: FastifyReply, code: number, message: string) {
  return reply.code(code).send({ error: message });
}

const id = z.coerce.number().int().positive();

const SettingsPatch = z
  .object({
    profile: z
      .object({
        summary: z.string().max(2000),
        skills: z.array(z.string().max(80)).max(50),
        hours_per_week: z.number().min(0).max(100),
        starting_capital_usd: z.number().min(0),
        risk_tolerance: z.enum(['low', 'medium', 'high']),
        notes: z.string().max(4000),
      })
      .partial(),
    worker_count: z.number().int().min(0).max(8),
    auto_mode: z.boolean(),
    paused: z.boolean(),
    daily_api_budget_usd: z.number().min(0).max(1000),
    per_run_budget_usd: z.number().min(0.01).max(50),
    per_action_cap_usd: z.number().min(0),
    daily_spend_cap_usd: z.number().min(0).max(10_000),
    daily_email_cap: z.number().int().min(0).max(500),
    vault_threshold: z.number().min(0).max(100),
    score_weights: z.record(z.string(), z.number().min(0).max(100)),
    scout_interval_min: z.number().min(1).max(1440),
    scout_batch: z.number().int().min(1).max(10),
    ntfy_url: z.union([z.literal(''), z.string().url()]),
    muted: z.boolean(),
  })
  .partial()
  .strict();

export function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true, mode: config.AUTH_MODE, live_enabled: config.ENABLE_LIVE }));
  app.get('/api/state', async () => snapshot());

  // ------------------------------------------------------------ settings & controls
  app.get('/api/settings', async () => ({ settings: getSettings(), max_workers: maxWorkers(), max_per_action_cap: maxPerActionCap(), auth_mode: config.AUTH_MODE, live_enabled: config.ENABLE_LIVE }));

  app.put('/api/settings', async (req, reply) => {
    const parsed = SettingsPatch.safeParse(req.body);
    if (!parsed.success) return bad(reply, 400, parsed.error.message);
    const patch = parsed.data as Partial<Settings>;
    if (patch.worker_count !== undefined && patch.worker_count > maxWorkers()) return bad(reply, 400, `Worker limit is ${maxWorkers()} (unlock upgrades for more)`);
    if (patch.per_action_cap_usd !== undefined && patch.per_action_cap_usd > maxPerActionCap()) return bad(reply, 400, `Per-action cap can't exceed $${maxPerActionCap()} yet (Treasury upgrade)`);
    if (patch.profile) patch.profile = { ...getSettings().profile, ...patch.profile };
    const s = updateSettings(patch);
    if (patch.daily_api_budget_usd !== undefined) {
      resetClockOutIfFunded();
      publishBudget();
    }
    void tick();
    return { settings: s };
  });

  app.post('/api/control/pause', async (req) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    updateSettings({ paused });
    feed(paused ? 'warn' : 'info', paused ? 'All work paused. Running agents finish their current step.' : 'Work resumed.');
    return { paused };
  });
  app.post('/api/control/auto', async (req, reply) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    if (on && getSettings().kill_switch) return bad(reply, 409, 'Re-arm the kill switch first');
    updateSettings({ auto_mode: on });
    feed('info', on ? 'Auto mode ON: the Scout will keep the dock stocked.' : 'Auto mode OFF: only crates you drop get processed.');
    void tick();
    return { auto_mode: on };
  });
  app.post('/api/control/kill', async () => {
    engageKillSwitch('user', 'kill switch pressed');
    return { kill_switch: true };
  });
  app.post('/api/control/rearm', async () => {
    rearm('user');
    return { kill_switch: false };
  });

  // ------------------------------------------------------------ crates
  app.post('/api/crates', async (req, reply) => {
    const body = z.object({ title: z.string().trim().min(3).max(200), body: z.string().max(4000).optional(), priority: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) return bad(reply, 400, body.error.message);
    const c = createCrate({ title: body.data.title, body: body.data.body ?? null, source: 'user', priority: body.data.priority ? 10 : 0 });
    audit('user', 'crate_dropped', `crate:${c.id}`, { title: c.title, priority: c.priority });
    feed('info', `You dropped a crate${c.priority ? ' (priority)' : ''}: "${c.title}"`, `crate:${c.id}`);
    void tick();
    return c;
  });

  app.get('/api/crates/:id', async (req, reply) => {
    const c = getCrate(id.parse((req.params as { id: string }).id));
    if (!c) return bad(reply, 404, 'No such crate');
    const opp = db.prepare('SELECT id FROM opportunities WHERE crate_id = ?').get(c.id) as { id: number } | undefined;
    return { crate: c, results: stageResults(c.id), runs: runsForCrate(c.id), sources: sourcesForCrate(c.id), opportunity_id: opp?.id ?? null };
  });

  app.post('/api/crates/:id/priority', async (req, reply) => {
    const c = getCrate(id.parse((req.params as { id: string }).id));
    if (!c) return bad(reply, 404, 'No such crate');
    const { priority } = z.object({ priority: z.boolean() }).parse(req.body);
    updateCrate(c.id, { priority: priority ? 10 : 0 });
    audit('user', 'crate_priority', `crate:${c.id}`, { priority });
    void tick();
    return getCrate(c.id);
  });

  app.post('/api/crates/:id/:action', async (req, reply) => {
    const { action } = req.params as { action: string };
    const c = getCrate(id.parse((req.params as { id: string }).id));
    if (!c) return bad(reply, 404, 'No such crate');
    if (action === 'retry' || action === 'unfreeze') {
      if (c.status !== 'stuck' && c.status !== 'frozen') return bad(reply, 409, `Crate is ${c.status}`);
      updateCrate(c.id, { status: 'queued', fail_count: 0, frozen_reason: null });
      audit('user', `crate_${action}`, `crate:${c.id}`, { previous: c.status, reason: c.frozen_reason });
      feed('info', `Crate "${c.title}" released back into the queue.`, `crate:${c.id}`);
      void tick();
    } else if (action === 'scrap') {
      if (c.status === 'in_progress') return bad(reply, 409, 'Crate is being worked on');
      updateCrate(c.id, { stage: 'scrap', status: 'done', rejection_reason: 'Scrapped by owner' });
      audit('user', 'crate_scrap', `crate:${c.id}`, null);
    } else return bad(reply, 404, 'Unknown action');
    return getCrate(c.id);
  });

  app.get('/api/buildings/:stage', async (req) => {
    const stage = (req.params as { stage: Stage }).stage;
    return { stage, crates: cratesAt(stage) };
  });

  // ------------------------------------------------------------ agents & runs
  app.get('/api/agents/:id', async (req, reply) => {
    const a = getAgent(id.parse((req.params as { id: string }).id));
    if (!a) return bad(reply, 404, 'No such agent');
    const runs = db.prepare('SELECT * FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 20').all(a.id);
    const current = a.current_run_id ? getRun(a.current_run_id) : null;
    return {
      agent: a,
      runs,
      current_run: current,
      events: current ? listRunEvents(current.id) : [],
      sources: current ? sourcesForRun(current.id) : [],
      crate: a.current_crate_id ? getCrate(a.current_crate_id) : null,
    };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const r = getRun(id.parse((req.params as { id: string }).id));
    if (!r) return bad(reply, 404, 'No such run');
    return { run: r, events: listRunEvents(r.id), sources: sourcesForRun(r.id), actions: db.prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY id').all(r.id) };
  });

  // ------------------------------------------------------------ vault / opportunities
  app.get('/api/opportunities/:id', async (req, reply) => {
    const o = getOpportunity(id.parse((req.params as { id: string }).id));
    if (!o) return bad(reply, 404, 'No such opportunity');
    const pnl = db.prepare('SELECT * FROM pnl_entries WHERE opportunity_id = ? ORDER BY id').all(o.id);
    return { opportunity: o, plan: planOf(o), step_state: statesOf(o), actions: listActions({ opportunity_id: o.id }), human_tasks: listHumanTasks(o.id), runs: runsForOpportunity(o.id), pnl, sources: sourcesForCrate(o.crate_id) };
  });

  app.post('/api/opportunities/:id/promote', async (req, reply) => {
    const o = getOpportunity(id.parse((req.params as { id: string }).id));
    if (!o) return bad(reply, 404, 'No such opportunity');
    if (!config.ENABLE_LIVE) return bad(reply, 403, 'Live execution is disabled. It unlocks in phase 6 after you review paper results (ENABLE_LIVE=true).');
    const { confirm_title } = z.object({ confirm_title: z.string() }).parse(req.body);
    if (confirm_title.trim() !== o.title.trim()) return bad(reply, 400, 'Type the strategy name exactly to confirm');
    if (o.status === 'frozen') return bad(reply, 409, 'Unfreeze the plan first');
    updateOpportunity(o.id, { mode: 'live', promoted_at: now() });
    audit('user', 'promotion', `opportunity:${o.id}`, { to: 'live', plan_hash: o.plan_hash });
    feed('warn', `"${o.title}" promoted to LIVE.`, `opportunity:${o.id}`);
    return getOpportunity(o.id);
  });

  app.post('/api/opportunities/:id/:action', async (req, reply) => {
    const { action } = req.params as { action: string };
    const o = getOpportunity(id.parse((req.params as { id: string }).id));
    if (!o) return bad(reply, 404, 'No such opportunity');
    switch (action) {
      case 'demote':
        updateOpportunity(o.id, { mode: 'paper' });
        audit('user', 'promotion', `opportunity:${o.id}`, { to: 'paper' });
        break;
      case 'pause':
        updateOpportunity(o.id, { status: 'paused' });
        audit('user', 'opportunity_pause', `opportunity:${o.id}`, null);
        break;
      case 'resume':
      case 'unfreeze':
        if (o.status === 'retired') return bad(reply, 409, 'Retired');
        updateOpportunity(o.id, { status: 'active', frozen_reason: null, next_exec_at: now() });
        audit('user', `opportunity_${action}`, `opportunity:${o.id}`, { reason: o.frozen_reason });
        break;
      case 'retire':
        updateOpportunity(o.id, { status: 'retired', next_exec_at: null });
        audit('user', 'opportunity_retire', `opportunity:${o.id}`, null);
        break;
      case 'execute':
        if (o.status !== 'active') return bad(reply, 409, `Opportunity is ${o.status}`);
        updateOpportunity(o.id, { next_exec_at: now() });
        void tick();
        break;
      case 'pnl': {
        const b = z.object({ amount_usd: z.number(), note: z.string().max(500).optional() }).parse(req.body);
        addPnl({ opportunity_id: o.id, amount_usd: b.amount_usd, kind: b.amount_usd >= 0 ? 'revenue' : 'manual', source: 'manual', mode: o.mode, note: b.note });
        audit('user', 'pnl_entry', `opportunity:${o.id}`, b);
        break;
      }
      default:
        return bad(reply, 404, 'Unknown action');
    }
    return getOpportunity(o.id);
  });

  app.post('/api/opportunities/:id/steps/:step/retry', async (req, reply) => {
    const o = getOpportunity(id.parse((req.params as { id: string }).id));
    const step = (req.params as { step: string }).step;
    if (!o) return bad(reply, 404, 'No such opportunity');
    if (!planOf(o).steps.some((s) => s.id === step)) return bad(reply, 404, 'No such step');
    setStepState(o.id, step, { status: 'pending', note: 'Retry requested by owner' });
    updateOpportunity(o.id, { next_exec_at: now() });
    audit('user', 'step_retry', `opportunity:${o.id}`, { step });
    void tick();
    return { ok: true };
  });

  // ------------------------------------------------------------ approvals
  app.get('/api/approvals', async () => ({ pending: db.prepare("SELECT * FROM actions WHERE status = 'pending_approval' ORDER BY id").all(), recent: listActions({ limit: 100 }) }));

  app.post('/api/approvals/:id/approve', async (req, reply) => {
    try {
      return await approve(id.parse((req.params as { id: string }).id));
    } catch (err) {
      if (err instanceof ApprovalError) return bad(reply, 409, err.message);
      throw err;
    }
  });
  app.post('/api/approvals/:id/reject', async (req, reply) => {
    try {
      const note = (req.body as { note?: string } | undefined)?.note;
      return reject(id.parse((req.params as { id: string }).id), 'user', note);
    } catch (err) {
      if (err instanceof ApprovalError) return bad(reply, 409, err.message);
      throw err;
    }
  });
  app.get('/api/actions/:id', async (req, reply) => {
    const a = getAction(id.parse((req.params as { id: string }).id));
    return a ?? bad(reply, 404, 'No such action');
  });

  // ------------------------------------------------------------ human tasks
  app.get('/api/human-tasks', async () => listHumanTasks());
  app.post('/api/human-tasks/:id/done', async (req, reply) => {
    const taskId = id.parse((req.params as { id: string }).id);
    const t = db.prepare('SELECT * FROM human_tasks WHERE id = ?').get(taskId) as { opportunity_id: number; step_id: string | null } | undefined;
    if (!t) return bad(reply, 404, 'No such task');
    completeHumanTask(taskId);
    if (t.step_id) {
      setStepState(t.opportunity_id, t.step_id, { status: 'done', note: 'Done by owner' });
      updateOpportunity(t.opportunity_id, { next_exec_at: now() });
      void tick();
    }
    return { ok: true };
  });

  // ------------------------------------------------------------ allowlist
  app.get('/api/allowlist', async () => listAllowlist());
  app.post('/api/allowlist', async (req, reply) => {
    const b = z
      .object({
        kind: z.enum(['email_address', 'email_domain', 'wallet_address', 'contract', 'x402_host', 'merchant']),
        value: z.string().trim().min(3).max(200),
        chain: z.string().max(40).nullable().optional(),
        label: z.string().max(100).nullable().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return bad(reply, 400, b.error.message);
    try {
      return { id: addAllowlist(b.data) };
    } catch {
      return bad(reply, 409, 'Already on the allowlist');
    }
  });
  app.delete('/api/allowlist/:id', async (req) => {
    removeAllowlist(id.parse((req.params as { id: string }).id));
    return { ok: true };
  });

  // ------------------------------------------------------------ MCP tools
  app.get('/api/mcp', async () => ({ servers: upstreamStatus(), tools: listTools().map(({ input_schema, ...t }) => ({ ...t, input_schema: JSON.parse(input_schema || '{}') })) }));
  app.post('/api/mcp/reconnect', async () => {
    await connectAll();
    return { servers: upstreamStatus() };
  });
  app.put('/api/mcp/tools/:server/:tool', async (req, reply) => {
    const { server, tool } = req.params as { server: string; tool: string };
    const b = z.object({ tier: z.number().int().min(0).max(3), reviewed: z.boolean().default(true) }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, b.error.message);
    setToolTier(server, tool, b.data.tier, b.data.reviewed);
    return { ok: true };
  });

  // ------------------------------------------------------------ audit (read only, by design)
  app.get('/api/audit', async (req) => {
    const q = z.object({ before: z.coerce.number().optional(), limit: z.coerce.number().optional(), kind: z.string().optional() }).parse(req.query);
    return listAudit(q);
  });
  app.get('/api/audit/verify', async () => verifyAudit());
}
