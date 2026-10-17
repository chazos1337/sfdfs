import crypto from 'node:crypto';
import type { Opportunity, Plan, PlanStep } from '@mf/shared';
import { db, initDb } from '../src/db/db';
import { createCrate, createOpportunity, createRun, ensureAgents, listAgents, upsertTool } from '../src/db/repo';
import { mapTool } from '../src/execution/tiers';

export const PAYBOX_TOOLS = [
  'list_credentials',
  'get_portfolio',
  'verify_solana_balance',
  'discover_tokens',
  'discover_services',
  'discover_plugins',
  'get_contract',
  'get_request',
  'list_requests',
  'check_operation_readiness',
  'reopen_signing_window',
  'resolve_username',
  'request_transfer',
  'use_service',
  'pay_x402',
  'request_swap',
  'request_payment',
  'use_plugin',
  'request_wallet_sign',
  'get_buy_link',
  'get_deposit_link',
  'claim_payment_credentials',
  'request_secret',
  'request_account_change',
] as const;

export const AGENTMAIL_TOOLS = [
  'list_inboxes',
  'get_inbox',
  'list_threads',
  'get_thread',
  'list_messages',
  'get_message',
  'get_attachment',
  'list_drafts',
  'get_draft',
  'create_draft',
  'update_draft',
  'send_message',
  'forward_message',
  'send_draft',
  'reply_to_message',
  'reply_all_message',
  'update_message',
  'create_inbox',
  'delete_inbox',
  'delete_draft',
] as const;

export function freshDb() {
  return initDb(':memory:');
}

/** Insert tool rows the way connectAll() would, optionally marking them reviewed. */
export function seedTools(server: string, profile: string, names: readonly string[], reviewed = true) {
  for (const name of names) {
    const m = mapTool(profile, name);
    upsertTool({ server, tool: name, description: null, input_schema: '{}', schema_hash: 'h:' + name, tier: m.tier, classifier: m.classifier });
    if (reviewed) db.prepare('UPDATE mcp_tools SET reviewed = 1 WHERE server = ? AND tool = ?').run(server, name);
  }
}

export function step(id: string, kind: PlanStep['kind'], extra: Partial<PlanStep> = {}): PlanStep {
  return { id, kind, description: `${kind} step ${id}`, params: {}, max_cost_usd: 0, depends_on: [], success_check: 'ok', ...extra };
}

export function makePlan(steps: PlanStep[]): Plan {
  return { objective: 'test', budget_cap_usd: 20, review_after_days: 14, kpis: [], kill_criteria: [], steps };
}

/** A crate + opportunity + agent + running executor run, ready for the gateway. */
export function seedOpportunity(plan: Plan, title = 'Test strategy'): { opp: Opportunity; runId: number; agentId: number } {
  ensureAgents(1);
  const agentId = listAgents()[0].id;
  const crate = createCrate({ title, source: 'user' });
  const planJson = JSON.stringify(plan);
  const opp = createOpportunity({
    crate_id: crate.id,
    title,
    summary: 's',
    score: 70,
    scores_json: '{}',
    confidence: 0.5,
    startup_cost_usd: 0,
    monthly_upside_low_usd: 0,
    monthly_upside_high_usd: 0,
    red_flags_json: '[]',
    report_md: '#',
    plan_json: planJson,
    plan_hash: crypto.createHash('sha256').update(planJson).digest('hex').slice(0, 16),
    next_exec_at: null,
  });
  const run = createRun({ agent_id: agentId, opportunity_id: opp.id, role: 'executor', model: 'mock', prompt_version: 'test' });
  return { opp, runId: run.id, agentId };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
