import type {
  Action,
  Agent,
  AllowlistEntry,
  Crate,
  HumanTask,
  McpToolRow,
  Opportunity,
  Plan,
  Run,
  RunEvent,
  Settings,
  Stage,
} from '@mf/shared';

// Typed fetch helpers for every REST endpoint the UI uses. Commands only:
// the resulting state changes arrive over the WebSocket.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : null) ?? (data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : null) ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const get = <T>(p: string) => req<T>('GET', p);
const post = <T>(p: string, body: unknown = {}) => req<T>('POST', p, body);
const put = <T>(p: string, body: unknown) => req<T>('PUT', p, body);
const del = <T>(p: string) => req<T>('DELETE', p);

// ------------------------------------------------------------ response shapes

export interface SourceRow {
  id: number;
  run_id: number;
  crate_id: number | null;
  url: string;
  title: string | null;
  claim: string | null;
  accessed_at: string;
}

export interface RunRow extends Run {
  session_id?: string | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}

export interface AgentDetail {
  agent: Agent;
  runs: RunRow[];
  current_run: RunRow | null;
  events: RunEvent[];
  sources: SourceRow[];
  crate: Crate | null;
}

export interface RunDetail {
  run: RunRow;
  events: RunEvent[];
  sources: SourceRow[];
  actions: Action[];
}

export interface CrateDetail {
  crate: Crate;
  results: Record<string, unknown>;
  runs: RunRow[];
  sources: SourceRow[];
  opportunity_id: number | null;
}

export type StepStatus = 'pending' | 'waiting_owner' | 'queued_for_approval' | 'blocked' | 'failed' | 'done' | 'simulated' | 'skipped';
export interface StepState {
  status: StepStatus;
  note?: string;
  action_ids?: number[];
  updated_at?: string;
}

export interface PnlEntry {
  id: number;
  opportunity_id: number;
  ts: string;
  amount_usd: number;
  kind: string;
  source: string;
  mode: 'paper' | 'live';
  note: string | null;
}

export interface OpportunityDetail {
  opportunity: Opportunity;
  plan: Plan;
  step_state: Record<string, StepState>;
  actions: Action[];
  human_tasks: HumanTask[];
  runs: RunRow[];
  pnl: PnlEntry[];
  sources: SourceRow[];
}

export interface McpServerStatus {
  name: string;
  profile: string | null;
  connected: boolean;
  tools: number;
  error?: string | null;
}
export interface McpToolDetail extends McpToolRow {
  input_schema: unknown;
  first_seen?: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  ref: string | null;
  data_json: string;
  prev_hash: string;
  hash: string;
}

// ------------------------------------------------------------ endpoints

export const api = {
  // settings & controls
  getSettings: () => get<{ settings: Settings; max_workers: number; max_per_action_cap: number; auth_mode: string; live_enabled: boolean }>('/api/settings'),
  putSettings: (patch: Partial<Settings>) => put<{ settings: Settings }>('/api/settings', patch),
  pause: (paused: boolean) => post<{ paused: boolean }>('/api/control/pause', { paused }),
  auto: (on: boolean) => post<{ auto_mode: boolean }>('/api/control/auto', { on }),
  kill: () => post<{ kill_switch: true }>('/api/control/kill'),
  rearm: () => post<{ kill_switch: false }>('/api/control/rearm'),

  // crates & buildings
  dropCrate: (title: string, body?: string, priority?: boolean) => post<Crate>('/api/crates', { title, body: body || undefined, priority }),
  crate: (id: number) => get<CrateDetail>(`/api/crates/${id}`),
  setPriority: (id: number, priority: boolean) => post<Crate>(`/api/crates/${id}/priority`, { priority }),
  crateAction: (id: number, action: 'retry' | 'unfreeze' | 'scrap') => post<Crate>(`/api/crates/${id}/${action}`),
  building: (stage: Stage) => get<{ stage: Stage; crates: Crate[] }>(`/api/buildings/${stage}`),

  // agents & runs
  agent: (id: number) => get<AgentDetail>(`/api/agents/${id}`),
  run: (id: number) => get<RunDetail>(`/api/runs/${id}`),

  // vault
  opportunity: (id: number) => get<OpportunityDetail>(`/api/opportunities/${id}`),
  oppAction: (id: number, action: 'execute' | 'pause' | 'resume' | 'unfreeze' | 'retire' | 'demote') => post<Opportunity>(`/api/opportunities/${id}/${action}`),
  promote: (id: number, confirm_title: string) => post<Opportunity>(`/api/opportunities/${id}/promote`, { confirm_title }),
  addPnl: (id: number, amount_usd: number, note?: string) => post<Opportunity>(`/api/opportunities/${id}/pnl`, { amount_usd, note: note || undefined }),
  retryStep: (id: number, step: string) => post<{ ok: true }>(`/api/opportunities/${id}/steps/${encodeURIComponent(step)}/retry`),
  humanTaskDone: (id: number) => post<{ ok: true }>(`/api/human-tasks/${id}/done`),

  // approvals & actions
  approvals: () => get<{ pending: Action[]; recent: Action[] }>('/api/approvals'),
  approve: (id: number) => post<unknown>(`/api/approvals/${id}/approve`),
  reject: (id: number, note?: string) => post<unknown>(`/api/approvals/${id}/reject`, note ? { note } : {}),
  action: (id: number) => get<Action>(`/api/actions/${id}`),

  // allowlist
  allowlist: () => get<AllowlistEntry[]>('/api/allowlist'),
  addAllowlist: (e: { kind: AllowlistEntry['kind']; value: string; chain?: string | null; label?: string | null }) => post<{ id: number }>('/api/allowlist', e),
  removeAllowlist: (id: number) => del<{ ok: true }>(`/api/allowlist/${id}`),

  // MCP
  mcp: () => get<{ servers: McpServerStatus[]; tools: McpToolDetail[] }>('/api/mcp'),
  mcpReconnect: () => post<{ servers: McpServerStatus[] }>('/api/mcp/reconnect'),
  setToolTier: (server: string, tool: string, tier: number, reviewed = true) =>
    put<{ ok: true }>(`/api/mcp/tools/${encodeURIComponent(server)}/${encodeURIComponent(tool)}`, { tier, reviewed }),

  // audit (read only)
  audit: (q: { before?: number; limit?: number; kind?: string }) => {
    const p = new URLSearchParams();
    if (q.before) p.set('before', String(q.before));
    if (q.limit) p.set('limit', String(q.limit));
    if (q.kind) p.set('kind', q.kind);
    return get<AuditRow[]>(`/api/audit?${p}`);
  },
  verifyAudit: () => get<{ ok: boolean; checked: number; brokenAt?: number }>('/api/audit/verify'),
};

/** Run an API call and surface failures with a toast-like alert. */
export async function attempt<T>(fn: () => Promise<T>, onError?: (msg: string) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
    else notifyError(msg);
    return undefined;
  }
}

type ErrorListener = (msg: string) => void;
const errorListeners = new Set<ErrorListener>();
export function onApiError(fn: ErrorListener) {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}
export function notifyError(msg: string) {
  for (const fn of errorListeners) fn(msg);
}
