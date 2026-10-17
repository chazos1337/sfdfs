import { now } from '../db/db';
import { feed, getAction, getOpportunity, updateAction, updateOpportunity } from '../db/repo';
import { setStepState } from '../pipeline/steps';
import { audit } from '../safety/audit';
import { isKilled } from '../safety/killSwitch';
import { finishAction } from './gateway';

export class ApprovalError extends Error {}

/**
 * Owner approved a parked tier-2 call. The gateway executes exactly the stored
 * call (or simulates it in paper mode). No LLM is involved, so what was
 * approved is byte-for-byte what runs.
 */
export async function approve(id: number, actor = 'user') {
  const a = getAction(id);
  if (!a) throw new ApprovalError('No such action');
  if (a.status !== 'pending_approval') throw new ApprovalError(`Action is ${a.status}, not pending`);
  if (isKilled()) throw new ApprovalError('Kill switch is engaged');
  const opp = a.opportunity_id ? getOpportunity(a.opportunity_id) : undefined;
  if (opp?.status === 'frozen') throw new ApprovalError('This plan is frozen for review. Unfreeze it first.');

  updateAction(id, { status: 'approved', decided_at: now() });
  audit(actor, 'approval', `action:${id}`, { decision: 'approved', tool: a.tool, amount_usd: a.amount_usd, recipient: a.recipient, mode: a.mode });
  feed('good', `Approved #${id} (${a.tool})`, `action:${id}`);

  const result = await finishAction({ ...a, status: 'approved' }, { tier: a.tier, taints: false, sanitize: true }, { runId: a.run_id, opportunityId: a.opportunity_id });
  const done = getAction(id)!;
  if (a.opportunity_id && a.step_id) {
    setStepState(a.opportunity_id, a.step_id, {
      status: done.status === 'failed' ? 'failed' : done.status === 'simulated' ? 'simulated' : 'done',
      note: `Approved by owner; ${done.status}`,
      action_ids: [id],
    });
  }
  // Let the executor pick up whatever depended on this step.
  if (a.opportunity_id) updateOpportunity(a.opportunity_id, { next_exec_at: now() });
  return { action: done, result };
}

export function reject(id: number, actor = 'user', note?: string) {
  const a = getAction(id);
  if (!a) throw new ApprovalError('No such action');
  if (a.status !== 'pending_approval') throw new ApprovalError(`Action is ${a.status}, not pending`);
  updateAction(id, { status: 'rejected', decided_at: now() });
  audit(actor, 'approval', `action:${id}`, { decision: 'rejected', note: note ?? null });
  feed('warn', `Rejected #${id} (${a.tool})`, `action:${id}`);
  if (a.opportunity_id && a.step_id) setStepState(a.opportunity_id, a.step_id, { status: 'failed', note: `Rejected by owner${note ? `: ${note}` : ''}`, action_ids: [id] });
  return getAction(id)!;
}
