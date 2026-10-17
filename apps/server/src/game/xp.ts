import { bus } from '../bus';
import { getAgent, updateAgent } from '../db/repo';

export const XP = {
  stageDone: 5,
  scoutIdea: 2,
  reachedVault: 50,
  perLiveDollar: 1,
} as const;

export function levelFor(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;
}

export function awardXp(agentId: number, amount: number, reason: string) {
  const a = getAgent(agentId);
  if (!a || amount <= 0) return;
  const xp = a.xp + Math.round(amount);
  const level = levelFor(xp);
  updateAgent(agentId, { xp, level });
  bus.publish({ type: 'xp.awarded', data: { agent_id: agentId, amount: Math.round(amount), reason } });
}
