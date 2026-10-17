import type { Agent, Stage } from '@mf/shared';

export const usd = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(digits)}`;

export const usdShort = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = a >= 10_000 ? `${(a / 1000).toFixed(0)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(2);
  return `${n < 0 ? '-' : ''}$${s}`;
};

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export function timeOf(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function ago(ts: string | null | undefined) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  return JSON.stringify(v, null, 2);
}

export function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Level = floor(sqrt(xp/25)) + 1, so level L starts at xp = 25*(L-1)^2. */
export function levelInfo(xp: number) {
  const level = Math.floor(Math.sqrt(xp / 25)) + 1;
  const base = 25 * (level - 1) ** 2;
  const next = 25 * level ** 2;
  return { level, base, next, progress: (xp - base) / (next - base) };
}

export const STAGE_LABEL: Record<Stage | 'breakroom', string> = {
  dock: 'Loading Dock',
  research: 'Research Lab',
  market: 'Market Scanner',
  validation: 'Validation Bench',
  vault: 'Vault',
  scrap: 'Scrap Heap',
  execution: 'Execution Yard',
  breakroom: 'Break Room',
};

export const STAGE_ICON: Record<Stage | 'breakroom', string> = {
  dock: '▣',
  research: '⚗',
  market: '◎',
  validation: '⚖',
  vault: '◆',
  scrap: '✕',
  execution: '⚙',
  breakroom: '☕',
};

export const STATE_COLOR: Record<Agent['state'], string> = {
  idle: '#8a9bd0',
  walking: '#6cb6ff',
  working: '#6fdc8c',
  thinking: '#c792ea',
  stuck: '#ff5c7a',
  awaiting_approval: '#ffd166',
  clocked_out: '#5a6fb0',
};

export const STATUS_COLOR: Record<string, string> = {
  queued: '#8a9bd0',
  in_progress: '#6cb6ff',
  done: '#6fdc8c',
  stuck: '#ffb454',
  frozen: '#ff5c7a',
  // actions
  simulated: '#8a9bd0',
  executed: '#6fdc8c',
  failed: '#ff5c7a',
  pending_approval: '#ffd166',
  approved: '#6fdc8c',
  rejected: '#ff5c7a',
  blocked: '#ff5c7a',
  expired: '#5a6fb0',
  // opportunities
  active: '#6fdc8c',
  paused: '#ffb454',
  retired: '#5a6fb0',
  // steps
  pending: '#8a9bd0',
  waiting_owner: '#ffd166',
  queued_for_approval: '#ffd166',
  skipped: '#5a6fb0',
  // runs
  running: '#6cb6ff',
  ok: '#6fdc8c',
  error: '#ff5c7a',
  aborted: '#ffb454',
  budget_exceeded: '#ffb454',
  killed: '#ff5c7a',
};

export const LEVEL_COLOR: Record<string, string> = {
  info: '#b8c4ea',
  good: '#6fdc8c',
  warn: '#ffb454',
  bad: '#ff5c7a',
};

/** Human-readable tool name: `paybox__request_swap` / `mcp__yard__paybox__request_swap` → `paybox › request swap`. */
export function toolLabel(server: string | null, tool: string) {
  const t = tool.replace(/^mcp__yard__/, '').replace(/^mcp__/, '');
  const parts = t.split('__');
  const name = parts.pop()!.replace(/_/g, ' ');
  const srv = server ?? parts.join(' › ');
  return srv ? `${srv} › ${name}` : name;
}
