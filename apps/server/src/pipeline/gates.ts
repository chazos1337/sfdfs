import { SCORE_DIMENSIONS, type RedFlag, type Settings, type ValidationOutput } from '@mf/shared';

/** Weighted 0-100 score, computed in code so the LLM can't round itself up. */
export function compositeScore(scores: ValidationOutput['scores'], weights: Record<string, number>): number {
  let total = 0;
  let weightSum = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const w = Math.max(0, weights[dim] ?? 0);
    const s = Math.max(0, Math.min(10, scores[dim]?.score ?? 0));
    total += s * w;
    weightSum += w;
  }
  return weightSum ? Math.round((total / weightSum) * 10 * 10) / 10 : 0;
}

export function highFlags(flags: RedFlag[]): RedFlag[] {
  return flags.filter((f) => f.severity === 'high');
}

export interface GateResult {
  pass: boolean;
  score: number;
  reason: string | null;
}

/**
 * Hard gates on top of the Validation agent's verdict. Any high-severity red
 * flag from any stage, a reject verdict, or a score under the threshold sends
 * the crate to the scrap heap.
 */
export function validationGate(v: ValidationOutput, earlierFlags: RedFlag[], s: Pick<Settings, 'score_weights' | 'vault_threshold'>): GateResult {
  const score = compositeScore(v.scores, s.score_weights);
  const high = highFlags([...earlierFlags, ...v.red_flags]);
  if (high.length) return { pass: false, score, reason: `Red flag: ${high[0].type.replace(/_/g, ' ')}: ${high[0].evidence}` };
  if (v.verdict === 'reject') return { pass: false, score, reason: v.rejection_reason ?? 'Rejected by validation' };
  if (score < s.vault_threshold) return { pass: false, score, reason: `Score ${score} is below the vault threshold of ${s.vault_threshold}` };
  return { pass: true, score, reason: null };
}
