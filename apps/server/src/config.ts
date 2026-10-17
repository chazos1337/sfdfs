import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)));

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  MOCK_AGENTS: bool(false),
  MOCK_SPEED: num(1),
  PORT: num(8787),
  HOST: z.string().default('127.0.0.1'),
  DB_PATH: z.string().default('data/money-factory.db'),
  MCP_CONFIG: z.string().default('config/mcp.json'),
  // Seeds for settings on first run; after that, the Settings panel wins.
  DAILY_API_BUDGET_USD: num(5),
  PER_RUN_BUDGET_USD: num(0.75),
  WORKER_COUNT: num(2),
  PER_ACTION_CAP_USD: num(10),
  DAILY_SPEND_CAP_USD: num(50),
  DAILY_EMAIL_CAP: num(20),
  NTFY_URL: z.string().default(''),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  // Phase 6 gate: live execution stays impossible until this is true.
  ENABLE_LIVE: bool(false),
  MODEL_SCOUT: z.string().default('claude-sonnet-5-5'),
  MODEL_RESEARCH: z.string().default('claude-sonnet-5-5'),
  MODEL_MARKET: z.string().default('claude-sonnet-5-5'),
  MODEL_VALIDATION: z.string().default('claude-opus-5-5'),
  MODEL_PLANNER: z.string().default('claude-opus-5-5'),
  MODEL_EXECUTOR: z.string().default('claude-opus-5-5'),
  TIMEZONE: z.string().default('Europe/Stockholm'),
});

const parsed = Env.parse(process.env);

// Without an API key the Agent SDK falls back to the local Claude Code login
// (e.g. a Pro/Max subscription via `claude login`). Usage then counts against
// the plan's limits rather than API billing, so default to lighter settings.
const subscription = !parsed.ANTHROPIC_API_KEY && !parsed.MOCK_AGENTS;
if (subscription) {
  for (const k of ['MODEL_VALIDATION', 'MODEL_PLANNER', 'MODEL_EXECUTOR'] as const)
    if (!process.env[k]) parsed[k] = 'claude-sonnet-5-5';
  if (!process.env.WORKER_COUNT) parsed.WORKER_COUNT = 1;
}

export const config = {
  ...parsed,
  AUTH_MODE: (parsed.MOCK_AGENTS ? 'mock' : subscription ? 'subscription' : 'api_key') as 'mock' | 'subscription' | 'api_key',
  DB_PATH: path.resolve(ROOT, parsed.DB_PATH),
  MCP_CONFIG: path.resolve(ROOT, parsed.MCP_CONFIG),
  AGENT_CWD: path.resolve(ROOT, 'data/agent-cwd'),
  WEB_DIST: path.resolve(ROOT, 'apps/web/dist'),
  ASSETS_DIR: path.resolve(ROOT, 'assets'),
};

export type Config = typeof config;
