import crypto from 'node:crypto';
import type {
  Crate,
  ExecutorOutput,
  MarketOutput,
  Opportunity,
  PlannerOutput,
  PlanStep,
  RedFlag,
  ResearchOutput,
  Role,
  ScoutOutput,
  Source,
  ValidationOutput,
} from '@mf/shared';
import { db, now } from '../db/db';
import {
  addHumanTask,
  addPnl,
  addSources,
  createCrate,
  createOpportunity,
  feed,
  getAgent,
  getCrate,
  getOpportunity,
  getSettings,
  listAllowlist,
  realizedLivePnl,
  saveStageResult,
  stageResults,
  updateAgent,
  updateCrate,
  updateOpportunity,
} from '../db/repo';
import { awardXp, XP } from '../game/xp';
import { checkUpgrades, scoutLimits } from '../game/upgrades';
import { audit } from '../safety/audit';
import { shouldFreeze } from '../safety/injection';
import { validationGate } from './gates';
import { dueSteps, planOf, setStepState, statesOf, TOOL_KINDS, type StepStatus } from './steps';

// ------------------------------------------------------------ prompt context

/** The owner's profile plus what the factory has learned so far. */
export function profileBlock(): string {
  const s = getSettings();
  const p = s.profile;
  const livePnl = realizedLivePnl();
  const vault = db.prepare('SELECT title, score, mode FROM opportunities ORDER BY id DESC LIMIT 20').all() as Array<{ title: string; score: number; mode: string }>;
  const scrap = db
    .prepare("SELECT title, rejection_reason FROM crates WHERE stage = 'scrap' ORDER BY updated_at DESC LIMIT 20")
    .all() as Array<{ title: string; rejection_reason: string | null }>;
  const doneTasks = db.prepare("SELECT text FROM human_tasks WHERE status = 'done' ORDER BY done_at DESC LIMIT 15").all() as Array<{ text: string }>;
  const lines = [
    '## Owner profile',
    p.summary,
    `- Skills: ${p.skills.length ? p.skills.join(', ') : 'not specified yet; infer from track record'}`,
    `- Hours per week: ${p.hours_per_week}`,
    `- Risk tolerance: ${p.risk_tolerance}`,
    `- Capital available now: ~$${Math.max(0, p.starting_capital_usd + livePnl).toFixed(0)} (starting $${p.starting_capital_usd} + realized live P&L $${livePnl.toFixed(2)})`,
    p.notes ? `- Notes: ${p.notes}` : '',
    '',
    '## Track record',
    vault.length ? 'Reached the vault:\n' + vault.map((v) => `- ${v.title} (score ${v.score}, ${v.mode})`).join('\n') : 'Nothing has reached the vault yet.',
    scrap.length ? 'Scrapped:\n' + scrap.map((c) => `- ${c.title}: ${c.rejection_reason ?? 'n/a'}`).join('\n') : 'Nothing scrapped yet.',
    doneTasks.length ? 'Tasks the owner has completed (evidence of skills/accounts):\n' + doneTasks.map((t) => `- ${t.text}`).join('\n') : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export function scoutPrompt(): { prompt: string; maxIdeas: number } {
  const s = getSettings();
  const maxIdeas = Math.min(s.scout_batch, scoutLimits().maxBatch);
  const titles = (db.prepare('SELECT title FROM crates ORDER BY id DESC LIMIT 200').all() as Array<{ title: string }>).map((r) => r.title);
  const prompt = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    profileBlock(),
    '',
    '## Already in the factory (do not duplicate)',
    titles.length ? titles.map((t) => `- ${t}`).join('\n') : '(none yet)',
    '',
    `Propose up to ${maxIdeas} new ideas.`,
  ].join('\n');
  return { prompt, maxIdeas };
}

function crateHeader(c: Crate) {
  return `# Crate: ${c.title}\n${c.body ? `\n${c.body}\n` : ''}${c.source === 'user' ? '\n(Dropped in by the owner.)' : ''}`;
}

export function stagePrompt(role: Role, c: Crate): string {
  const r = stageResults(c.id);
  const parts = [crateHeader(c), '', profileBlock()];
  if (role !== 'research' && r.research) parts.push('', '## Research notes (from an agent that read untrusted web pages)', '```json', JSON.stringify(r.research, null, 1), '```');
  if ((role === 'validation' || role === 'planner') && r.market) parts.push('', '## Market scan', '```json', JSON.stringify(r.market, null, 1), '```');
  if (role === 'planner' && r.validation) {
    parts.push('', '## Validation', '```json', JSON.stringify(r.validation, null, 1), '```');
    const allow = listAllowlist();
    parts.push(
      '',
      '## Allowlist (the only recipients you may name; anything else must be "<OWNER_TO_PROVIDE>")',
      allow.length ? allow.map((a) => `- ${a.kind}: ${a.value}${a.chain ? ` (${a.chain})` : ''}${a.label ? `: ${a.label}` : ''}`).join('\n') : '(empty)',
      '',
      `Spending limits: per action $${getSettings().per_action_cap_usd}, per day $${getSettings().daily_spend_cap_usd}.`,
    );
  }
  return parts.join('\n');
}

export function executorPrompt(opp: Opportunity, due: PlanStep[], mode: 'paper' | 'live'): string {
  const plan = planOf(opp);
  const states = statesOf(opp);
  const s = getSettings();
  return [
    `# Strategy: ${opp.title}`,
    `Mode: ${mode.toUpperCase()}${mode === 'paper' ? ' (all actions are simulated)' : ''}`,
    `Plan hash: ${opp.plan_hash}`,
    '',
    '## Full plan',
    '```json',
    JSON.stringify(plan, null, 1),
    '```',
    '',
    '## Step status so far',
    '```json',
    JSON.stringify(states, null, 1),
    '```',
    '',
    `## Due now: ${due.map((d) => d.id).join(', ')}`,
    'Carry out only these steps. Pass the step id as `mf_step_id` and a one-line reason as `mf_why` on every tool call.',
    `Limits: per action $${s.per_action_cap_usd}, per day $${s.daily_spend_cap_usd}.`,
  ].join('\n');
}

// ------------------------------------------------------------ output handlers

function freezeCrate(c: Crate, reason: string, runId: number) {
  updateCrate(c.id, { status: 'frozen', frozen_reason: reason });
  audit('system', 'injection_flag', `crate:${c.id}`, { reason, run_id: runId });
  feed('bad', `Crate "${c.title}" frozen for review: ${reason}`, `crate:${c.id}`);
}

function saveSources(runId: number, crateId: number | null, sources: Source[] | undefined, fetched: string[]) {
  const list = (sources ?? []).map((s) => ({ url: s.url, title: s.title, claim: s.claim }));
  const known = new Set(list.map((s) => s.url));
  for (const u of fetched) if (!known.has(u)) list.push({ url: u, title: '', claim: '' });
  if (list.length) addSources(runId, crateId, list);
}

function scrap(c: Crate, reason: string) {
  updateCrate(c.id, { stage: 'scrap', status: 'done', rejection_reason: reason });
  feed('warn', `Scrapped "${c.title}": ${reason}`, `crate:${c.id}`);
}

export function handleScout(out: ScoutOutput, runId: number, agentId: number, fetched: string[]) {
  const { maxIdeas } = scoutPrompt();
  let made = 0;
  for (const idea of out.ideas.slice(0, maxIdeas)) {
    const body = `${idea.pitch}\n\nWhy this fits: ${idea.why_this_person}\nCategory: ${idea.category} · est. startup $${idea.est_startup_cost_usd} · ~${idea.est_hours_per_week} h/week`;
    const c = createCrate({ title: idea.title, body, source: 'scout', origin_agent_id: agentId });
    saveSources(runId, c.id, idea.sources, []);
    const f = shouldFreeze(idea);
    if (f.freeze) freezeCrate(c, f.reason!, runId);
    made++;
    awardXp(agentId, XP.scoutIdea, 'scouted an idea');
  }
  saveSources(runId, null, [], fetched);
  if (out.injection_suspected.length) audit('system', 'injection_reported', `run:${runId}`, out.injection_suspected);
  feed('info', `${getAgent(agentId)?.name ?? 'Scout'} dropped ${made} new crate(s) on the dock.`);
}

const NEXT: Partial<Record<Role, Crate['stage']>> = { research: 'market', market: 'validation' };

export function handleStage(role: 'research' | 'market' | 'validation' | 'planner', c: Crate, output: unknown, runId: number, agentId: number, fetched: string[]) {
  saveStageResult(c.id, role, runId, output);
  const withSources = output as { sources?: Source[] };
  saveSources(runId, c.id, withSources.sources, fetched);
  awardXp(agentId, XP.stageDone, `${role} done`);

  const f = shouldFreeze(output);
  if (f.freeze) {
    freezeCrate(c, f.reason!, runId);
    return;
  }

  if (role === 'research' || role === 'market') {
    const flags = (output as ResearchOutput | MarketOutput).red_flags;
    const high = flags.find((x) => x.severity === 'high');
    if (high) return scrap(c, `Red flag: ${high.type.replace(/_/g, ' ')}: ${high.evidence}`);
    updateCrate(c.id, { stage: NEXT[role]!, status: 'queued' });
    return;
  }

  if (role === 'validation') {
    const v = output as ValidationOutput;
    const r = stageResults(c.id) as { research?: ResearchOutput; market?: MarketOutput };
    const earlier: RedFlag[] = [...(r.research?.red_flags ?? []), ...(r.market?.red_flags ?? [])];
    const gate = validationGate(v, earlier, getSettings());
    audit('system', 'validation_gate', `crate:${c.id}`, gate);
    if (!gate.pass) return scrap(c, gate.reason!);
    updateCrate(c.id, { stage: 'vault', status: 'queued' });
    feed('good', `"${c.title}" passed validation with ${gate.score}/100. Heading to the vault.`, `crate:${c.id}`);
    return;
  }

  // planner: create the opportunity and its plan
  const p = output as PlannerOutput;
  const r = stageResults(c.id) as { research?: ResearchOutput; market?: MarketOutput; validation?: ValidationOutput };
  const v = r.validation!;
  const gate = validationGate(v, [], getSettings());
  const planJson = JSON.stringify(p.plan);
  const opp = createOpportunity({
    crate_id: c.id,
    title: c.title,
    summary: r.research?.summary ?? c.body ?? '',
    score: gate.score,
    scores_json: JSON.stringify(v.scores),
    confidence: v.confidence,
    startup_cost_usd: v.startup_cost_usd,
    monthly_upside_low_usd: v.monthly_upside_usd.low,
    monthly_upside_high_usd: v.monthly_upside_usd.high,
    red_flags_json: JSON.stringify([...(r.research?.red_flags ?? []), ...(r.market?.red_flags ?? []), ...v.red_flags]),
    report_md: p.report_md,
    plan_json: planJson,
    plan_hash: crypto.createHash('sha256').update(planJson).digest('hex').slice(0, 16),
    next_exec_at: now(),
  });
  updateCrate(c.id, { stage: 'vault', status: 'done' });
  audit('system', 'opportunity_created', `opportunity:${opp.id}`, { crate_id: c.id, plan_hash: opp.plan_hash, mode: 'paper' });
  feed('good', `New opportunity in the vault: "${c.title}" (${gate.score}/100, paper mode).`, `opportunity:${opp.id}`);

  // Everyone who worked on this crate shares the credit.
  const workers = new Set<number>(
    (db.prepare('SELECT DISTINCT agent_id FROM runs WHERE crate_id = ?').all(c.id) as Array<{ agent_id: number }>).map((x) => x.agent_id),
  );
  if (c.origin_agent_id) workers.add(c.origin_agent_id);
  for (const id of workers) {
    awardXp(id, XP.reachedVault, `"${c.title}" reached the vault`);
    const a = getAgent(id);
    if (a) updateAgent(id, { ideas_vaulted: a.ideas_vaulted + 1 });
  }
  checkUpgrades();
}

/**
 * Steps that need no tools are settled in code: human tasks go to the owner,
 * waits schedule the next check. Returns the steps that still need the executor.
 */
export function settleNonToolSteps(opp: Opportunity): PlanStep[] {
  const plan = planOf(opp);
  let due = dueSteps(plan, statesOf(opp));
  let guard = 0;
  while (guard++ < 10) {
    const nonTool = due.filter((s) => !TOOL_KINDS.includes(s.kind));
    if (!nonTool.length) break;
    for (const s of nonTool) {
      if (s.kind === 'wait') {
        const hours = Number(s.params.wait_hours ?? 24);
        setStepState(opp.id, s.id, { status: 'done', note: `Waited ${hours}h (scheduled)` });
        updateOpportunity(opp.id, { next_exec_at: new Date(Date.now() + hours * 3600_000).toISOString() });
      } else {
        addHumanTask(opp.id, s.id, s.description);
        setStepState(opp.id, s.id, { status: 'waiting_owner', note: 'Owner task' });
      }
    }
    due = dueSteps(plan, statesOf(getOpportunity(opp.id)!));
  }
  return due.filter((s) => TOOL_KINDS.includes(s.kind));
}

export function handleExecutor(opp: Opportunity, out: ExecutorOutput, runId: number, agentId: number, due: PlanStep[]) {
  const map: Record<ExecutorOutput['steps'][number]['status'], StepStatus> = {
    done: 'done',
    simulated: 'simulated',
    queued_for_approval: 'queued_for_approval',
    blocked: 'waiting_owner',
    failed: 'failed',
    skipped: 'skipped',
  };
  const dueIds = new Set(due.map((d) => d.id));
  const plan = planOf(opp);
  for (const s of out.steps) {
    if (!dueIds.has(s.step_id)) continue; // ignore claims about steps it wasn't given
    // If the owner already decided a parked call, keep that decision.
    const fresh = getOpportunity(opp.id);
    const current = fresh ? statesOf(fresh)[s.step_id]?.status : undefined;
    if (s.status === 'queued_for_approval' && current && ['done', 'simulated', 'failed'].includes(current)) continue;
    setStepState(opp.id, s.step_id, { status: map[s.status], note: s.note.slice(0, 300), action_ids: s.action_ids });
    if (s.status === 'blocked') {
      const step = plan.steps.find((p) => p.id === s.step_id);
      addHumanTask(opp.id, s.step_id, `${step?.description ?? s.step_id}: ${s.note}`.slice(0, 400));
    }
  }
  // Steps it was given but didn't report on are marked failed (retryable from
  // the Vault view) so the scheduler can't loop on them.
  for (const id of dueIds) if (!out.steps.some((s) => s.step_id === id)) setStepState(opp.id, id, { status: 'failed', note: 'Not attempted by the executor' });
  for (const t of out.human_tasks) if (!plan.steps.some((p) => t.includes(p.description))) addHumanTask(opp.id, null, t.slice(0, 400));

  if (out.suspicious.length) {
    const reason = `Executor reported suspicious content: "${out.suspicious[0].quote.slice(0, 160)}" (${out.suspicious[0].where})`;
    updateOpportunity(opp.id, { status: 'frozen', frozen_reason: reason });
    audit('system', 'injection_flag', `opportunity:${opp.id}`, out.suspicious);
    feed('bad', `Plan "${opp.title}" frozen for review. ${reason}`, `opportunity:${opp.id}`);
  }
  if (out.observed_revenue_usd && out.observed_revenue_usd > 0 && opp.mode === 'live') {
    addPnl({ opportunity_id: opp.id, amount_usd: out.observed_revenue_usd, kind: 'revenue', source: `run:${runId}`, mode: 'live', note: out.summary.slice(0, 200) });
    awardXp(agentId, out.observed_revenue_usd, 'earned live revenue');
    const a = getAgent(agentId);
    if (a) updateAgent(agentId, { earned_usd: a.earned_usd + out.observed_revenue_usd });
    feed('good', `Revenue! $${out.observed_revenue_usd.toFixed(2)} from "${opp.title}"`, `opportunity:${opp.id}`);
    checkUpgrades();
  }
  awardXp(agentId, XP.stageDone, 'executor run');
  feed('info', `Executor on "${opp.title}": ${out.summary.slice(0, 160)}`, `opportunity:${opp.id}`);
}

export function crateById(id: number) {
  return getCrate(id);
}
