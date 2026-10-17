export type Role = 'scout' | 'research' | 'market' | 'validation' | 'planner' | 'executor';

export type Stage = 'dock' | 'research' | 'market' | 'validation' | 'vault' | 'scrap' | 'execution';
export const BUILDINGS: Stage[] = ['dock', 'research', 'market', 'validation', 'vault', 'scrap', 'execution'];

export type CrateStatus = 'queued' | 'in_progress' | 'done' | 'stuck' | 'frozen';

export interface Crate {
  id: number;
  title: string;
  body: string | null;
  source: 'user' | 'scout';
  priority: number;
  stage: Stage;
  status: CrateStatus;
  fail_count: number;
  frozen_reason: string | null;
  rejection_reason: string | null;
  origin_agent_id: number | null;
  created_at: string;
  updated_at: string;
}

export type AgentState =
  | 'idle'
  | 'walking'
  | 'working'
  | 'thinking'
  | 'stuck'
  | 'awaiting_approval'
  | 'clocked_out';

export interface Agent {
  id: number;
  name: string;
  palette: string;
  xp: number;
  level: number;
  ideas_vaulted: number;
  earned_usd: number;
  state: AgentState;
  current_crate_id: number | null;
  current_run_id: number | null;
  current_opportunity_id: number | null;
  current_role: Role | null;
  building: Stage | 'breakroom';
  bubble: string | null;
  progress: number | null;
}

export type RunStatus = 'running' | 'ok' | 'error' | 'aborted' | 'budget_exceeded' | 'killed';

export interface Run {
  id: number;
  agent_id: number;
  crate_id: number | null;
  opportunity_id: number | null;
  role: Role;
  model: string;
  prompt_version: string;
  status: RunStatus;
  num_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  tainted: number;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export type RunEventType = 'system' | 'assistant_text' | 'thinking' | 'tool_use' | 'tool_result' | 'result' | 'error';

export interface RunEvent {
  run_id: number;
  seq: number;
  ts: string;
  type: RunEventType;
  payload: unknown;
}

export type Mode = 'paper' | 'live';

export interface Opportunity {
  id: number;
  crate_id: number;
  title: string;
  summary: string;
  score: number;
  scores_json: string;
  confidence: number;
  startup_cost_usd: number | null;
  monthly_upside_low_usd: number | null;
  monthly_upside_high_usd: number | null;
  red_flags_json: string;
  report_md: string;
  plan_json: string;
  plan_hash: string;
  step_state_json: string;
  mode: Mode;
  status: 'active' | 'paused' | 'frozen' | 'retired';
  frozen_reason: string | null;
  next_exec_at: string | null;
  promoted_at: string | null;
  created_at: string;
}

export type Tier = 0 | 1 | 2 | 3;

export type ActionStatus =
  | 'simulated'
  | 'executed'
  | 'failed'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'expired';

export interface Action {
  id: number;
  opportunity_id: number | null;
  run_id: number | null;
  step_id: string | null;
  server: string;
  tool: string;
  input_json: string;
  tier: Tier;
  tier_reason: string;
  mode: Mode;
  status: ActionStatus;
  amount_usd: number | null;
  recipient: string | null;
  why: string | null;
  simulation_json: string | null;
  output_json: string | null;
  tx_hash: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
}

export interface FeedItem {
  id: number;
  ts: string;
  level: 'info' | 'good' | 'warn' | 'bad';
  text: string;
  ref: string | null;
}

export interface Budget {
  day: string;
  api_spent_usd: number;
  api_cap_usd: number;
  wallet_spent_usd: number;
  wallet_cap_usd: number;
  paper_spent_usd: number;
}

export interface Profile {
  summary: string;
  skills: string[];
  hours_per_week: number;
  starting_capital_usd: number;
  risk_tolerance: 'low' | 'medium' | 'high';
  notes: string;
}

export interface Settings {
  profile: Profile;
  worker_count: number;
  auto_mode: boolean;
  paused: boolean;
  kill_switch: boolean;
  daily_api_budget_usd: number;
  per_run_budget_usd: number;
  per_action_cap_usd: number;
  daily_spend_cap_usd: number;
  daily_email_cap: number;
  vault_threshold: number;
  score_weights: Record<string, number>;
  scout_interval_min: number;
  scout_batch: number;
  ntfy_url: string;
  muted: boolean;
}

export interface Upgrade {
  key: string;
  name: string;
  description: string;
  milestone: string;
  unlocked_at: string | null;
  progress: number; // 0..1
}

export interface HudStats {
  active_workers: number;
  ideas_processed_today: number;
  vault_count: number;
  wallet_balance_usd: number | null;
  pnl: Array<{ opportunity_id: number; title: string; mode: Mode; total_usd: number }>;
}

export interface McpToolRow {
  server: string;
  tool: string;
  description: string | null;
  tier: Tier;
  classifier: string | null;
  reviewed: number;
  connected: boolean;
}

export interface AllowlistEntry {
  id: number;
  kind: 'email_address' | 'email_domain' | 'wallet_address' | 'contract' | 'x402_host' | 'merchant';
  value: string;
  chain: string | null;
  label: string | null;
  added_at: string;
}

export interface HumanTask {
  id: number;
  opportunity_id: number;
  step_id: string | null;
  text: string;
  status: 'open' | 'done';
  created_at: string;
}

export interface Snapshot {
  settings: Settings;
  live_enabled: boolean;
  mock: boolean;
  max_workers: number;
  agents: Agent[];
  crates: Crate[];
  opportunities: Opportunity[];
  approvals: Action[];
  budget: Budget;
  hud: HudStats;
  feed: FeedItem[];
  upgrades: Upgrade[];
}
