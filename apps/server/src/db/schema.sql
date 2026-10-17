PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allowlist (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email_address','email_domain','wallet_address','contract','x402_host','merchant')),
  value TEXT NOT NULL,
  chain TEXT,
  label TEXT,
  added_at TEXT NOT NULL,
  UNIQUE (kind, value, chain)
);

CREATE TABLE IF NOT EXISTS mcp_tools (
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  tier INTEGER NOT NULL DEFAULT 3,
  classifier TEXT,
  reviewed INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  schema_hash TEXT,
  PRIMARY KEY (server, tool)
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  palette TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  ideas_vaulted INTEGER NOT NULL DEFAULT 0,
  earned_usd REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',
  current_crate_id INTEGER,
  current_run_id INTEGER,
  current_opportunity_id INTEGER,
  current_role TEXT,
  building TEXT NOT NULL DEFAULT 'breakroom',
  bubble TEXT,
  progress REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crates (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  source TEXT NOT NULL CHECK (source IN ('user','scout')),
  priority INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  frozen_reason TEXT,
  rejection_reason TEXT,
  origin_agent_id INTEGER REFERENCES agents(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crates_queue ON crates (stage, status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  crate_id INTEGER REFERENCES crates(id),
  opportunity_id INTEGER,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  num_turns INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  tainted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_crate ON runs (crate_id);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS stage_results (
  id INTEGER PRIMARY KEY,
  crate_id INTEGER NOT NULL REFERENCES crates(id),
  stage TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stage_results_crate ON stage_results (crate_id, stage);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  crate_id INTEGER,
  url TEXT NOT NULL,
  title TEXT,
  claim TEXT,
  accessed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  crate_id INTEGER NOT NULL UNIQUE REFERENCES crates(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  score REAL NOT NULL,
  scores_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  startup_cost_usd REAL,
  monthly_upside_low_usd REAL,
  monthly_upside_high_usd REAL,
  red_flags_json TEXT NOT NULL DEFAULT '[]',
  report_md TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  step_state_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
  status TEXT NOT NULL DEFAULT 'active',
  frozen_reason TEXT,
  next_exec_at TEXT,
  promoted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER,
  run_id INTEGER,
  step_id TEXT,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  tier INTEGER NOT NULL,
  tier_reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_usd REAL,
  recipient TEXT,
  why TEXT,
  simulation_json TEXT,
  output_json TEXT,
  tx_hash TEXT,
  external_request_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status);

CREATE TABLE IF NOT EXISTS human_tasks (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
  step_id TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS pnl_entries (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api','wallet','wallet_paper')),
  amount_usd REAL NOT NULL,
  ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_day ON spend_ledger (day, kind);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  data_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  ref TEXT
);

CREATE TABLE IF NOT EXISTS upgrades (
  key TEXT PRIMARY KEY,
  unlocked_at TEXT NOT NULL
);

-- Append-only tables: nothing in the app can rewrite history.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON actions
  BEGIN SELECT RAISE(ABORT, 'actions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON spend_ledger
  BEGIN SELECT RAISE(ABORT, 'spend_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON spend_ledger
  BEGIN SELECT RAISE(ABORT, 'spend_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pnl_no_update BEFORE UPDATE ON pnl_entries
  BEGIN SELECT RAISE(ABORT, 'pnl_entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS pnl_no_delete BEFORE DELETE ON pnl_entries
  BEGIN SELECT RAISE(ABORT, 'pnl_entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS run_events_no_delete BEFORE DELETE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
