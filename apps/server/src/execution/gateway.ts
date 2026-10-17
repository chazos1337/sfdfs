import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Action, Mode, Plan } from '@mf/shared';
import { config } from '../config';
import { db, now } from '../db/db';
import { addLedger, createAction, feed, getOpportunity, getRun, getTool, updateAction, updateAgent, updateOpportunity } from '../db/repo';
import { notify } from '../notify/ntfy';
import { audit } from '../safety/audit';
import { publishBudget } from '../safety/budget';
import { scanForInjection } from '../safety/injection';
import { isKilled } from '../safety/killSwitch';
import { callUpstream, profileOf, resultJson, resultText, upstreamTools, type UpstreamResult } from './mcpClients';
import { evaluate, type Decision } from './policy';
import { sanitizeLabels } from './pricing';

// The yard gateway: the ONLY path from an executor agent to the wallet and the
// inbox. It is an MCP server on 127.0.0.1 with one unguessable URL per run.
// Each call is tiered, checked against caps/allowlists/the plan, simulated in
// paper mode, parked for approval at tier 2, refused at tier 3, and audited.

export interface RunCtx {
  runId: number;
  agentId: number;
  opportunityId: number;
  mode: Mode;
  plan: Plan;
  abort: AbortController;
}

const runs = new Map<string, RunCtx>();
let server: http.Server | null = null;
let baseUrl = '';

const SEP = '__';

export async function startGateway(): Promise<string> {
  if (server) return baseUrl;
  server = http.createServer(handleHttp);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return baseUrl;
}

export async function stopGateway() {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
}

export function registerRun(ctx: RunCtx): { url: string; token: string } {
  const token = crypto.randomBytes(24).toString('hex');
  runs.set(token, ctx);
  return { url: `${baseUrl}/yard/${token}`, token };
}

export function unregisterRun(token: string) {
  runs.delete(token);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const m = /^\/yard\/([a-f0-9]{48})$/.exec(req.url ?? '');
  const ctx = m ? runs.get(m[1]) : undefined;
  if (!ctx) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    // Stateless MCP: a fresh server + transport per request, bound to this run.
    const mcp = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/** Tools an executor may see: reviewed, connected and not blocked. */
export function exposedTools() {
  return upstreamTools()
    .map(({ server: srv, tool }) => ({ srv, tool, row: getTool(srv, tool.name) }))
    .filter((t) => t.row && t.row.reviewed && t.row.tier < 3);
}

function buildServer(ctx: RunCtx) {
  const mcp = new Server({ name: 'yard', version: '0.1.0' }, { capabilities: { tools: {} } });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools().map(({ srv, tool, row }) => {
      const schema = { type: 'object', ...(tool.inputSchema ?? {}) } as { properties?: Record<string, unknown>; required?: string[] };
      const properties = {
        ...(schema.properties ?? {}),
        mf_step_id: { type: 'string', description: 'Id of the plan step this call serves, e.g. "s3". Required for anything that acts.' },
        mf_why: { type: 'string', description: 'One sentence the owner will see explaining why this call is needed.' },
      };
      return {
        name: `${srv}${SEP}${tool.name}`,
        description: `[Tier ${row!.tier}] ${tool.description ?? ''}`.slice(0, 2000),
        inputSchema: { ...schema, type: 'object' as const, properties },
      };
    }),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => handleCall(ctx, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
  return mcp;
}

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: t }], isError };
}

function effectiveMode(ctx: { opportunityId: number | null; mode: Mode }): Mode {
  // Live needs both the server flag (phase 6) and the strategy promoted.
  return config.ENABLE_LIVE && ctx.mode === 'live' ? 'live' : 'paper';
}

export async function handleCall(ctx: RunCtx, name: string, rawArgs: Record<string, unknown>): Promise<CallToolResult> {
  const sepAt = name.indexOf(SEP);
  const srv = name.slice(0, sepAt);
  const tool = name.slice(sepAt + SEP.length);
  const { mf_step_id, mf_why, ...args } = rawArgs;
  const stepId = typeof mf_step_id === 'string' ? mf_step_id : null;
  const why = typeof mf_why === 'string' ? mf_why.slice(0, 500) : null;
  const actor = `agent:${ctx.agentId}`;
  const mode = effectiveMode(ctx);

  audit(actor, 'tool_call', `run:${ctx.runId}`, { server: srv, tool, args, step_id: stepId, why, mode });

  if (isKilled()) {
    audit('system', 'tool_refused', `run:${ctx.runId}`, { server: srv, tool, reason: 'kill switch' });
    return text('Refused: the kill switch is engaged. Stop now.', true);
  }
  if (sepAt < 0 || !getTool(srv, tool)) return text(`Unknown tool ${name}.`, true);

  const opp = getOpportunity(ctx.opportunityId);
  const run = getRun(ctx.runId);
  const tainted = !!run?.tainted;
  let quotedUsd: number | null = null;
  if (profileOf(srv) === 'paybox' && tool === 'use_service' && args.mode !== 'probe') quotedUsd = await probeX402(srv, args);

  const decision = await evaluate(srv, tool, args, { runId: ctx.runId, opportunityId: ctx.opportunityId, mode, tainted, plan: ctx.plan, stepId }, { quotedUsd });
  if (opp && opp.status !== 'active' && decision.tier >= 1) decision.tier = Math.max(decision.tier, 2) as Decision['tier'];

  const base = {
    opportunity_id: ctx.opportunityId,
    run_id: ctx.runId,
    step_id: stepId,
    server: srv,
    tool,
    input_json: JSON.stringify(args),
    tier: decision.tier,
    tier_reason: decision.reasons.join('; '),
    mode,
    amount_usd: decision.amountUsd,
    recipient: decision.recipient,
    why,
    tx_hash: null,
  };

  // Tier 3: never.
  if (decision.tier === 3) {
    const a = createAction({ ...base, status: 'blocked', simulation_json: null, output_json: null });
    audit('system', 'tool_blocked', `action:${a.id}`, decision);
    feed('bad', `Blocked ${srv}/${tool} (#${a.id}): ${decision.reasons.at(-1)}`, `action:${a.id}`);
    return text(`Blocked (#${a.id}): ${decision.reasons.at(-1)}. This action is not allowed. Do not retry or work around it.`, true);
  }

  // Tier 2: park the exact call for the owner.
  if (decision.tier === 2) {
    const simulation = await simulate(srv, tool, args);
    const a = createAction({ ...base, status: 'pending_approval', simulation_json: JSON.stringify(simulation), output_json: null });
    audit('system', 'approval_requested', `action:${a.id}`, decision);
    updateAgent(ctx.agentId, { state: 'awaiting_approval', bubble: `Waiting for approval #${a.id}` });
    feed('warn', `Approval needed (#${a.id}): ${srv}/${tool}${decision.amountUsd !== null ? ` $${decision.amountUsd.toFixed(2)}` : ''}${decision.recipient ? ` → ${decision.recipient}` : ''}`, `action:${a.id}`);
    void notify(`Approval needed: ${tool}`, `${opp?.title ?? ''}\n${why ?? ''}\n${decision.reasons.filter((r) => !r.startsWith('base')).join('; ')}`, {
      priority: 'high',
      tags: ['warning'],
      path: `/?approval=${a.id}`,
    });
    return text(`Queued for owner approval (#${a.id}). Reason: ${decision.reasons.filter((r) => !r.startsWith('base')).join('; ')}. Do not retry; continue with other steps or finish.`);
  }

  // Tier 0/1: run (tier 1 writes are simulated in paper mode).
  const a = createAction({ ...base, status: 'executed', simulation_json: null, output_json: null });
  return finishAction(a, decision, ctx);
}

/** Execute or simulate an allowed action and record the outcome. */
export async function finishAction(a: Action, decision: Pick<Decision, 'tier' | 'taints' | 'sanitize'>, ctx: { runId: number | null; opportunityId: number | null; agentId?: number }): Promise<CallToolResult> {
  const args = JSON.parse(a.input_json) as Record<string, unknown>;
  const writes = a.tier >= 1;
  try {
    let resultForAgent: unknown;
    let isError = false;
    let txHash: string | null = null;
    if (writes && a.mode === 'paper') {
      resultForAgent = paperResult(a.tool, a.id, args);
      updateAction(a.id, { status: 'simulated', output_json: JSON.stringify(resultForAgent), executed_at: now() });
      if (a.amount_usd) addLedger('wallet_paper', a.amount_usd, `action:${a.id}`);
    } else {
      const res = await callUpstream(a.server, a.tool, args);
      isError = res.isError;
      resultForAgent = decision.sanitize ? sanitizeLabels(resultJson(res)) : resultJson(res);
      txHash = writes ? findTxHash(resultJson(res)) : null;
      updateAction(a.id, { status: res.isError ? 'failed' : 'executed', output_json: JSON.stringify(resultJson(res)).slice(0, 100_000), tx_hash: txHash, executed_at: now() });
      if (writes && !res.isError && a.amount_usd) addLedger('wallet', a.amount_usd, `action:${a.id}`);
      postReadChecks(a, resultForAgent, decision, ctx);
    }
    if (a.amount_usd) publishBudget();
    audit('system', 'tool_result', `action:${a.id}`, { status: isError ? 'failed' : writes && a.mode === 'paper' ? 'simulated' : 'executed', tx_hash: txHash });
    if (writes) feed(a.mode === 'paper' ? 'info' : 'good', `${a.mode === 'paper' ? 'Simulated' : 'Executed'} ${a.server}/${a.tool} (#${a.id})${a.amount_usd ? ` $${a.amount_usd.toFixed(2)}` : ''}`, `action:${a.id}`);
    const prefix = writes && a.mode === 'paper' ? `PAPER MODE: simulated, nothing was sent (#${a.id}).\n` : `(#${a.id})\n`;
    return text(prefix + (typeof resultForAgent === 'string' ? resultForAgent : JSON.stringify(resultForAgent, null, 1)).slice(0, 30_000), isError);
  } catch (err) {
    updateAction(a.id, { status: 'failed', output_json: JSON.stringify({ error: String(err) }), executed_at: now() });
    audit('system', 'tool_error', `action:${a.id}`, { error: String(err) });
    return text(`Tool error (#${a.id}): ${String(err)}`, true);
  }
}

/** Checks run on exactly what the agent will see (after label sanitizing). */
function postReadChecks(a: Action, seen: unknown, decision: Pick<Decision, 'taints'>, ctx: { runId: number | null; opportunityId: number | null }) {
  if (decision.taints && ctx.runId) db.prepare('UPDATE runs SET tainted = 1 WHERE id = ?').run(ctx.runId);
  const hits = scanForInjection(seen).filter((h) => h.level === 'freeze');
  if (hits.length && ctx.opportunityId) {
    const reason = `Instruction-like text in ${a.server}/${a.tool} result (#${a.id}): "${hits[0].excerpt}"`;
    updateOpportunity(ctx.opportunityId, { status: 'frozen', frozen_reason: reason });
    audit('system', 'injection_flag', `action:${a.id}`, hits);
    feed('bad', `Plan frozen for review. ${reason}`, `opportunity:${ctx.opportunityId}`);
    if (ctx.runId) for (const r of runs.values()) if (r.runId === ctx.runId) r.abort.abort('injection detected');
  }
}

function paperResult(tool: string, id: number, args: Record<string, unknown>) {
  const ref = `paper_${id}`;
  if (/transfer|swap|payment|x402|use_service|sign/.test(tool)) return { status: 'success', simulated: true, request_id: ref, transaction_hash: `PAPER-${id}`, echo: args };
  if (/send|reply|forward/.test(tool)) return { simulated: true, message_id: `<${ref}@paper.money-factory>`, thread_id: ref };
  return { simulated: true, note: 'Paper mode: not executed.' };
}

const TX_KEYS = ['tx_hash', 'txHash', 'transaction_hash', 'transactionHash', 'signature', 'hash'];
function findTxHash(v: unknown, depth = 0): string | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  for (const [k, val] of Object.entries(v)) {
    if (TX_KEYS.includes(k) && typeof val === 'string' && val.length >= 32) return val;
    const nested = findTxHash(val, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Dry run for the approval card, where the wallet supports one. */
async function simulate(srv: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (profileOf(srv) !== 'paybox' || !getTool(srv, 'check_operation_readiness')) return { supported: false };
  try {
    const res = await callUpstream(srv, 'check_operation_readiness', { operation: { tool, ...args } });
    return { supported: true, result: sanitizeLabels(resultJson(res)) };
  } catch (err) {
    return { supported: true, error: String(err) };
  }
}

/** Unpaid probe of an x402 service to learn its price before deciding. */
async function probeX402(srv: string, args: Record<string, unknown>): Promise<number | null> {
  try {
    const res = await callUpstream(srv, 'use_service', { ...args, mode: 'probe' });
    const found = findKey(resultJson(res), 'amount_usd');
    const n = Number(typeof found === 'string' ? found.replace(/[$,]/g, '') : found);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function findKey(v: unknown, key: string, depth = 0): unknown {
  if (!v || typeof v !== 'object' || depth > 6) return undefined;
  for (const [k, val] of Object.entries(v)) {
    if (k === key) return val;
    const nested = findKey(val, key, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
