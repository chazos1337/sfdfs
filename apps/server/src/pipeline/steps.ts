import type { Opportunity, Plan, PlanStep } from '@mf/shared';
import { json, now } from '../db/db';
import { getOpportunity, updateOpportunity } from '../db/repo';

export type StepStatus =
  | 'pending'
  | 'waiting_owner'
  | 'queued_for_approval'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'simulated'
  | 'skipped';

export interface StepState {
  status: StepStatus;
  note?: string;
  action_ids?: number[];
  updated_at?: string;
}

export type StepStates = Record<string, StepState>;

const FINISHED: StepStatus[] = ['done', 'simulated', 'skipped'];
/** Steps that may need tools; everything else is handled without an LLM. */
export const TOOL_KINDS: PlanStep['kind'][] = ['email_send', 'wallet_read', 'transfer', 'swap', 'x402_call', 'card_purchase'];

export function planOf(opp: Opportunity): Plan {
  return json<Plan>(opp.plan_json, { objective: '', budget_cap_usd: 0, review_after_days: 14, kpis: [], kill_criteria: [], steps: [] });
}

export function statesOf(opp: Opportunity): StepStates {
  return json<StepStates>(opp.step_state_json, {});
}

export function setStepState(oppId: number, stepId: string, patch: StepState) {
  const opp = getOpportunity(oppId);
  if (!opp) return;
  const states = statesOf(opp);
  const prev = states[stepId] ?? { status: 'pending' };
  states[stepId] = {
    ...prev,
    ...patch,
    action_ids: [...new Set([...(prev.action_ids ?? []), ...(patch.action_ids ?? [])])],
    updated_at: now(),
  };
  updateOpportunity(oppId, { step_state_json: JSON.stringify(states) });
}

/** Steps whose dependencies are finished and that haven't run yet. */
export function dueSteps(plan: Plan, states: StepStates): PlanStep[] {
  const statusOf = (id: string) => states[id]?.status ?? 'pending';
  return plan.steps.filter((s) => statusOf(s.id) === 'pending' && s.depends_on.every((d) => FINISHED.includes(statusOf(d))));
}

export function planProgress(plan: Plan, states: StepStates): number {
  if (!plan.steps.length) return 0;
  return plan.steps.filter((s) => FINISHED.includes(states[s.id]?.status ?? 'pending')).length / plan.steps.length;
}
