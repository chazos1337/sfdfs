import type { Agent, Crate, ExecutorOutput, Opportunity, PlanStep, Role, ScoutOutput, Stage } from '@mf/shared';
import { runAgent } from '../agents/runner';
import { promptVersion, ROLES } from '../agents/roles';
import { config } from '../config';
import { db, now } from '../db/db';
import {
  addLedger,
  createRun,
  ensureAgents,
  feed,
  getCrate,
  getKv,
  getOpportunity,
  getSettings,
  listAgents,
  setKv,
  updateAgent,
  updateCrate,
  updateOpportunity,
  updateRun,
} from '../db/repo';
import { registerRun, unregisterRun } from '../execution/gateway';
import { maxWorkers, scoutLimits } from '../game/upgrades';
import { activeRuns } from '../runtime';
import { apiRemaining, checkBudget, isClockedOut, publishBudget } from '../safety/budget';
import { isKilled } from '../safety/killSwitch';
import { executorPrompt, handleExecutor, handleScout, handleStage, scoutPrompt, settleNonToolSteps, stagePrompt } from './stages';
import { planOf } from './steps';

type Job =
  | { kind: 'stage'; role: 'research' | 'market' | 'validation' | 'planner'; crate: Crate }
  | { kind: 'scout' }
  | { kind: 'executor'; opp: Opportunity; due: PlanStep[] };

/** Where a crate waits (stage, status=queued) → which role processes it. */
const ROLE_FOR_QUEUE: Partial<Record<Stage, 'research' | 'market' | 'validation' | 'planner'>> = {
  dock: 'research',
  market: 'market',
  validation: 'validation',
  vault: 'planner',
};
/** Building an agent walks to for a role. */
const BUILDING_FOR: Record<Role, Stage> = {
  scout: 'dock',
  research: 'research',
  market: 'market',
  validation: 'validation',
  planner: 'vault',
  executor: 'execution',
};

const MIN_RUN_BUDGET = 0.03;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let rateLimitedUntil = 0;
const busyOpps = new Set<number>();

export function startScheduler(intervalMs = 1000) {
  stopScheduler();
  // Crates left in progress by a previous process go back in the queue.
  db.prepare("UPDATE crates SET status = 'queued', updated_at = ? WHERE status = 'in_progress'").run(now());
  db.prepare("UPDATE runs SET status = 'aborted', error = 'server restarted', ended_at = ? WHERE status = 'running'").run(now());
  for (const a of listAgents())
    if (a.state !== 'clocked_out') updateAgent(a.id, { state: 'idle', building: 'breakroom', bubble: null, progress: null, current_crate_id: null, current_run_id: null, current_opportunity_id: null, current_role: null });
  timer = setInterval(() => void tick(), intervalMs);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function workerLimit(): number {
  return Math.max(0, Math.min(getSettings().worker_count, maxWorkers()));
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = getSettings();
    ensureAgents(Math.max(s.worker_count, 1));
    if (isKilled() || s.paused) return;
    checkBudget();
    if (isClockedOut() || Date.now() < rateLimitedUntil) return;
    const limit = workerLimit();
    while (activeRuns.size < limit) {
      if (apiRemaining() < MIN_RUN_BUDGET) break;
      const agent = freeAgent(limit);
      if (!agent) break;
      const job = nextJob();
      if (!job) break;
      void runJob(job, agent);
    }
  } finally {
    ticking = false;
  }
}

function freeAgent(limit: number): Agent | undefined {
  const busy = new Set([...activeRuns.values()].map((r) => r.agentId));
  return listAgents()
    .slice(0, limit)
    .find((a) => !busy.has(a.id) && a.state !== 'clocked_out');
}

function nextQueuedCrate(onlyUser: boolean, priorityOnly: boolean): Crate | undefined {
  // Later stages first: finish work before starting new work.
  for (const stage of ['vault', 'validation', 'market', 'dock'] as Stage[]) {
    const c = db
      .prepare(
        `SELECT * FROM crates WHERE stage = ? AND status = 'queued' ${onlyUser ? "AND source = 'user'" : ''} ${priorityOnly ? 'AND priority > 0' : ''}
         ORDER BY priority DESC, created_at LIMIT 1`,
      )
      .get(stage) as Crate | undefined;
    if (c) return c;
  }
  return undefined;
}

function dueExecutorJob(onlyUser: boolean): Job | undefined {
  const opps = db
    .prepare(
      `SELECT o.* FROM opportunities o JOIN crates c ON c.id = o.crate_id
       WHERE o.status = 'active' AND o.next_exec_at IS NOT NULL AND o.next_exec_at <= ? ${onlyUser ? "AND c.source = 'user'" : ''}
       ORDER BY o.next_exec_at LIMIT 20`,
    )
    .all(now()) as Opportunity[];
  for (const opp of opps) {
    if (busyOpps.has(opp.id)) continue;
    const due = settleNonToolSteps(opp);
    if (!due.length) {
      // Nothing for the executor right now: wait for the owner or an approval.
      const fresh = getOpportunity(opp.id)!;
      if (fresh.next_exec_at && fresh.next_exec_at <= now()) updateOpportunity(opp.id, { next_exec_at: null });
      continue;
    }
    return { kind: 'executor', opp: getOpportunity(opp.id)!, due };
  }
  return undefined;
}

function nextJob(): Job | undefined {
  const s = getSettings();
  const onlyUser = !s.auto_mode;
  const prio = nextQueuedCrate(onlyUser, true);
  if (prio) return { kind: 'stage', role: ROLE_FOR_QUEUE[prio.stage]!, crate: prio };
  const exec = dueExecutorJob(onlyUser);
  if (exec) return exec;
  const c = nextQueuedCrate(onlyUser, false);
  if (c) return { kind: 'stage', role: ROLE_FOR_QUEUE[c.stage]!, crate: c };
  if (s.auto_mode && scoutDue()) return { kind: 'scout' };
  return undefined;
}

function scoutDue(): boolean {
  if ([...activeRuns.values()].some((r) => r.role === 'scout')) return false;
  const dockQueued = (db.prepare("SELECT COUNT(*) n FROM crates WHERE stage = 'dock' AND status = 'queued'").get() as { n: number }).n;
  if (dockQueued > 0) return false;
  const interval = Math.max(getSettings().scout_interval_min, scoutLimits().minIntervalMin);
  const last = getKv<number>('last_scout_at', 0);
  return Date.now() - last >= interval * 60_000;
}

async function runJob(job: Job, agent: Agent) {
  const role: Role = job.kind === 'stage' ? job.role : job.kind;
  const spec = ROLES[role];
  const building = BUILDING_FOR[role];
  const crate = job.kind === 'stage' ? job.crate : null;
  const opp = job.kind === 'executor' ? job.opp : null;

  const run = createRun({ agent_id: agent.id, crate_id: crate?.id ?? null, opportunity_id: opp?.id ?? null, role, model: config.MOCK_AGENTS ? 'mock' : spec.model, prompt_version: promptVersion(role) });
  const abort = new AbortController();
  const active = { runId: run.id, agentId: agent.id, role, abort, estimateUsd: 0 };
  activeRuns.set(run.id, active);
  if (crate) updateCrate(crate.id, { stage: role === 'planner' ? 'vault' : building, status: 'in_progress' });
  if (opp) busyOpps.add(opp.id);
  if (job.kind === 'scout') setKv('last_scout_at', Date.now());
  updateAgent(agent.id, {
    state: 'walking',
    building,
    bubble: crate ? `Carrying "${crate.title.slice(0, 40)}"` : role === 'scout' ? 'Scouting for ideas' : `Executing "${opp!.title.slice(0, 40)}"`,
    progress: 0,
    current_crate_id: crate?.id ?? null,
    current_run_id: run.id,
    current_opportunity_id: opp?.id ?? null,
    current_role: role,
  });

  let gatewayToken: string | null = null;
  let prompt: string;
  let systemVars: Record<string, string | number> = {};
  let mockContext: unknown;
  let yardUrl: string | undefined;
  if (job.kind === 'scout') {
    const sp = scoutPrompt();
    prompt = sp.prompt;
    systemVars = { max_ideas: sp.maxIdeas };
  } else if (job.kind === 'stage') prompt = stagePrompt(job.role, job.crate);
  else {
    const mode = config.ENABLE_LIVE && job.opp.mode === 'live' ? 'live' : 'paper';
    prompt = executorPrompt(job.opp, job.due, mode);
    const reg = registerRun({ runId: run.id, agentId: agent.id, opportunityId: job.opp.id, mode: job.opp.mode, plan: planOf(job.opp), abort });
    gatewayToken = reg.token;
    yardUrl = reg.url;
    mockContext = { plan: planOf(job.opp), dueStepIds: job.due.map((d) => d.id), mode };
  }

  const maxBudget = Math.max(0.01, Math.min(getSettings().per_run_budget_usd, apiRemaining()));
  let lastBubbleAt = 0;
  const outcome = await runAgent({
    role,
    runId: run.id,
    userPrompt: prompt,
    systemVars,
    maxBudgetUsd: maxBudget,
    abort,
    yardUrl,
    mockContext,
    onActivity: (a) => {
      if (a.estimateUsd !== undefined) {
        active.estimateUsd = a.estimateUsd;
        checkBudget();
      }
      if (a.bubble || a.progress !== undefined) {
        const t = Date.now();
        if (t - lastBubbleAt < 300 && a.progress === undefined) return;
        lastBubbleAt = t;
        const current = listAgents().find((x) => x.id === agent.id);
        updateAgent(agent.id, {
          state: current?.state === 'awaiting_approval' ? 'awaiting_approval' : a.progress === undefined ? 'thinking' : 'working',
          ...(a.bubble ? { bubble: a.bubble } : {}),
          ...(a.progress !== undefined ? { progress: a.progress } : {}),
        });
      }
    },
  });

  if (gatewayToken) unregisterRun(gatewayToken);
  activeRuns.delete(run.id);
  if (opp) busyOpps.delete(opp.id);
  if (outcome.costUsd > 0) addLedger('api', outcome.costUsd, `run:${run.id}`);
  updateRun(run.id, {
    status: outcome.ok ? 'ok' : outcome.status,
    error: outcome.ok ? null : outcome.error,
    cost_usd: outcome.costUsd,
    num_turns: outcome.numTurns,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    cache_read_tokens: outcome.cacheReadTokens,
    cache_write_tokens: outcome.cacheWriteTokens,
    session_id: outcome.sessionId ?? undefined,
    ended_at: now(),
  });
  publishBudget();
  checkBudget();

  let nextBuilding: Stage | 'breakroom' = building;
  try {
    if (outcome.ok) {
      if (job.kind === 'scout') handleScout(outcome.output as ScoutOutput, run.id, agent.id, outcome.fetchedUrls);
      else if (job.kind === 'stage') {
        const fresh = getCrate(job.crate.id)!;
        if (fresh.status === 'in_progress') handleStage(job.role, fresh, outcome.output, run.id, agent.id, outcome.fetchedUrls);
        nextBuilding = getCrate(job.crate.id)!.stage;
      } else {
        const fresh = getOpportunity(job.opp.id)!;
        handleExecutor(fresh, outcome.output as ExecutorOutput, run.id, agent.id, job.due);
        const after = getOpportunity(job.opp.id)!;
        if (after.status === 'active' && !after.next_exec_at) updateOpportunity(job.opp.id, { next_exec_at: now() });
      }
    } else handleFailure(job, outcome.status, outcome.error, agent);
  } catch (err) {
    feed('bad', `Internal error handling ${role} result: ${String(err)}`);
    handleFailure(job, 'error', String(err), agent);
  }

  const a = listAgents().find((x) => x.id === agent.id);
  if (a && a.state !== 'clocked_out' && a.state !== 'stuck')
    updateAgent(agent.id, {
      state: 'idle',
      building: nextBuilding,
      bubble: null,
      progress: null,
      current_crate_id: null,
      current_run_id: null,
      current_opportunity_id: null,
      current_role: null,
    });
}

function handleFailure(job: Job, status: string, error: string, agent: Agent) {
  if (/rate.?limit|usage limit|429|overloaded/i.test(error)) {
    rateLimitedUntil = Date.now() + 10 * 60_000;
    feed('warn', `Hit a usage/rate limit. Workers take a 10-minute break. (${error.slice(0, 120)})`);
  }
  if (job.kind === 'stage') {
    const c = getCrate(job.crate.id)!;
    const back: Stage = job.role === 'research' ? 'dock' : job.role === 'planner' ? 'vault' : job.role;
    if (status === 'aborted' || status === 'budget_exceeded') {
      if (c.status === 'in_progress') updateCrate(c.id, { stage: back, status: 'queued' });
      return;
    }
    const fails = c.fail_count + 1;
    if (fails >= 2) {
      updateCrate(c.id, { stage: back, status: 'stuck', fail_count: fails, frozen_reason: error.slice(0, 500) });
      updateAgent(agent.id, { state: 'stuck', bubble: 'Stuck! Needs a look', progress: null });
      setTimeout(() => {
        const a = listAgents().find((x) => x.id === agent.id);
        if (a?.state === 'stuck') updateAgent(agent.id, { state: 'idle', bubble: null, current_crate_id: null, current_run_id: null, current_role: null });
      }, 8000);
      feed('bad', `Crate "${c.title}" is stuck after ${fails} failures: ${error.slice(0, 160)}`, `crate:${c.id}`);
    } else {
      updateCrate(c.id, { stage: back, status: 'queued', fail_count: fails });
      feed('warn', `${job.role} on "${c.title}" failed, will retry: ${error.slice(0, 160)}`, `crate:${c.id}`);
    }
  } else if (job.kind === 'executor') {
    if (status !== 'aborted') feed('bad', `Executor on "${job.opp.title}" failed: ${error.slice(0, 160)}`, `opportunity:${job.opp.id}`);
    updateOpportunity(job.opp.id, { next_exec_at: status === 'aborted' ? null : new Date(Date.now() + 30 * 60_000).toISOString() });
  } else if (status !== 'aborted') feed('bad', `Scout run failed: ${error.slice(0, 160)}`);
}
