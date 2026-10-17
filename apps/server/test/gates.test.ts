import { describe, expect, it } from 'vitest';
import type { RedFlag, ValidationOutput } from '@mf/shared';
import { compositeScore, highFlags, validationGate } from '../src/pipeline/gates';

type Scores = ValidationOutput['scores'];
const DIMS = ['startup_cost', 'time_to_first_dollar', 'skill_fit', 'risk', 'scalability', 'legality'] as const;

function scores(values: Partial<Record<(typeof DIMS)[number], number>> | number): Scores {
  const out = {} as Record<string, { score: number; rationale: string; source_ids: string[] }>;
  for (const d of DIMS) out[d] = { score: typeof values === 'number' ? values : (values[d] ?? 0), rationale: 'r', source_ids: [] };
  return out as Scores;
}

const WEIGHTS = { startup_cost: 20, time_to_first_dollar: 20, skill_fit: 15, risk: 20, scalability: 20, legality: 5 };
const SETTINGS = { score_weights: WEIGHTS, vault_threshold: 60 };

function validation(over: Partial<ValidationOutput> = {}): ValidationOutput {
  return {
    scores: scores(8),
    monthly_upside_usd: { low: 10, high: 100, assumptions: [] },
    startup_cost_usd: 0,
    confidence: 0.6,
    verdict: 'approve',
    red_flags: [],
    sources: [],
    injection_suspected: [],
    ...over,
  };
}

const flag = (severity: RedFlag['severity'], type: RedFlag['type'] = 'guaranteed_returns'): RedFlag => ({ type, severity, evidence: 'Promises 2% a day' });

describe('compositeScore', () => {
  it('uniform scores give score × 10 regardless of weights', () => {
    expect(compositeScore(scores(7), WEIGHTS)).toBe(70);
    expect(compositeScore(scores(10), WEIGHTS)).toBe(100);
    expect(compositeScore(scores(0), WEIGHTS)).toBe(0);
  });

  it('is a weighted average', () => {
    // only startup_cost (weight 20 of 100) at 10 → 20
    expect(compositeScore(scores({ startup_cost: 10 }), WEIGHTS)).toBe(20);
    // legality alone carries 5% of the weight
    expect(compositeScore(scores({ legality: 10 }), WEIGHTS)).toBe(5);
    // weights need not sum to 100
    expect(compositeScore(scores({ risk: 10 }), { risk: 1, scalability: 1 })).toBe(50);
  });

  it('rounds to one decimal', () => {
    expect(compositeScore(scores({ skill_fit: 7 }), WEIGHTS)).toBe(10.5);
    expect(compositeScore(scores({ risk: 1 }), { risk: 1, scalability: 2 })).toBe(3.3);
  });

  it('clamps scores into 0..10', () => {
    expect(compositeScore(scores(42), WEIGHTS)).toBe(100);
    expect(compositeScore(scores(-5), WEIGHTS)).toBe(0);
    expect(compositeScore(scores({ startup_cost: 1000, risk: -1000 }), { startup_cost: 1, risk: 1 })).toBe(50);
  });

  it('ignores negative weights and missing dimensions; zero weight → 0', () => {
    expect(compositeScore(scores({ startup_cost: 10, risk: 0 }), { startup_cost: 1, risk: -100 })).toBe(100);
    expect(compositeScore(scores(9), {})).toBe(0);
    expect(compositeScore({} as Scores, WEIGHTS)).toBe(0);
  });

  it('cannot be inflated by extra dimensions', () => {
    const s = { ...scores(5), bonus: { score: 10, rationale: '', source_ids: [] } } as unknown as Scores;
    expect(compositeScore(s, { ...WEIGHTS, bonus: 1000 })).toBe(50);
  });
});

describe('validationGate', () => {
  it('passes a strong approve', () => {
    expect(validationGate(validation(), [], SETTINGS)).toEqual({ pass: true, score: 80, reason: null });
  });

  it('a high red flag from an earlier stage fails even with a perfect score', () => {
    const g = validationGate(validation({ scores: scores(10) }), [flag('high')], SETTINGS);
    expect(g.pass).toBe(false);
    expect(g.score).toBe(100);
    expect(g.reason).toBe('Red flag: guaranteed returns: Promises 2% a day');
  });

  it('a high red flag from validation itself fails', () => {
    expect(validationGate(validation({ red_flags: [flag('high', 'mlm')] }), [], SETTINGS).reason).toMatch(/^Red flag: mlm/);
  });

  it('low and medium red flags do not fail the gate', () => {
    expect(validationGate(validation({ red_flags: [flag('medium')] }), [flag('low')], SETTINGS).pass).toBe(true);
    expect(highFlags([flag('low'), flag('high'), flag('medium')])).toHaveLength(1);
  });

  it('a reject verdict fails', () => {
    const g = validationGate(validation({ verdict: 'reject', rejection_reason: 'Saturated market' }), [], SETTINGS);
    expect(g).toEqual({ pass: false, score: 80, reason: 'Saturated market' });
    expect(validationGate(validation({ verdict: 'reject' }), [], SETTINGS).reason).toBe('Rejected by validation');
  });

  it('below the threshold fails; exactly at the threshold passes', () => {
    const low = validationGate(validation({ scores: scores(5.9) }), [], SETTINGS);
    expect(low.pass).toBe(false);
    expect(low.reason).toBe('Score 59 is below the vault threshold of 60');
    expect(validationGate(validation({ scores: scores(6) }), [], SETTINGS).pass).toBe(true);
  });

  it('red flags are checked before the verdict and the score', () => {
    const g = validationGate(validation({ verdict: 'reject', scores: scores(1) }), [flag('high')], SETTINGS);
    expect(g.reason).toMatch(/^Red flag/);
  });
});
