// Live, in-memory registry of running agent runs, so the kill switch and the
// budget meter can reach every one of them.

export interface ActiveRun {
  runId: number;
  agentId: number;
  role: string;
  abort: AbortController;
  /** Running cost estimate from streamed usage (replaced by the real total at the end). */
  estimateUsd: number;
}

export const activeRuns = new Map<number, ActiveRun>();

export function abortAll(reason: string) {
  for (const r of activeRuns.values()) r.abort.abort(reason);
}

export function inFlightEstimate(): number {
  let s = 0;
  for (const r of activeRuns.values()) s += r.estimateUsd;
  return s;
}
