import type { Budget } from '@mf/shared';
import { bus } from '../bus';
import { today } from '../db/db';
import { feed, getSettings, listAgents, spentToday, updateAgent, updateSettings } from '../db/repo';
import { abortAll, inFlightEstimate } from '../runtime';
import { audit } from './audit';

// $ per million tokens. Used only for the live estimate while a run streams;
// the authoritative number is total_cost_usd from the Agent SDK result.
const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
};

export function estimateCost(
  model: string,
  u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5'];
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) /
    1_000_000
  );
}

export function budget(): Budget {
  const s = getSettings();
  return {
    day: today(),
    api_spent_usd: spentToday('api'),
    api_cap_usd: s.daily_api_budget_usd,
    wallet_spent_usd: spentToday('wallet'),
    wallet_cap_usd: s.daily_spend_cap_usd,
    paper_spent_usd: spentToday('wallet_paper'),
  };
}

export function publishBudget() {
  bus.publish({ type: 'budget.updated', data: budget() });
}

/** API dollars left today, counting what in-flight runs have already burned. */
export function apiRemaining(): number {
  const b = budget();
  return b.api_cap_usd - b.api_spent_usd - inFlightEstimate();
}

let clockedOutDay: string | null = null;

export function isClockedOut(): boolean {
  return clockedOutDay === today();
}

/**
 * Called whenever spend moves. When the day's API budget is gone every worker
 * clocks out: running agents are aborted and auto mode turns off.
 */
export function checkBudget() {
  if (apiRemaining() > 0.0001) {
    if (clockedOutDay && clockedOutDay !== today()) clockedOutDay = null;
    return;
  }
  if (isClockedOut()) return;
  clockedOutDay = today();
  abortAll('daily API budget reached');
  const s = getSettings();
  if (s.auto_mode) updateSettings({ auto_mode: false }, 'system');
  for (const a of listAgents()) updateAgent(a.id, { state: 'clocked_out', building: 'breakroom', bubble: 'Out of fuel', progress: null });
  audit('system', 'budget_exhausted', null, budget());
  feed('bad', `Daily API budget of $${s.daily_api_budget_usd.toFixed(2)} reached. All workers clocked out and auto mode paused.`);
  publishBudget();
}

/** Raising the cap (or a new day) lets workers clock back in. */
export function resetClockOutIfFunded() {
  if (clockedOutDay && apiRemaining() > 0.0001) {
    clockedOutDay = null;
    for (const a of listAgents()) if (a.state === 'clocked_out') updateAgent(a.id, { state: 'idle', bubble: null });
    feed('info', 'Fuel topped up: workers are back on shift.');
  }
}
