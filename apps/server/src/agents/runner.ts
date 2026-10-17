import fs from 'node:fs';
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { Role } from '@mf/shared';
import { config } from '../config';
import { addRunEvent } from '../db/repo';
import { estimateCost } from '../safety/budget';
import { runMock } from './mockRunner';
import { ROLES, outputJsonSchema, outputSchema, systemPrompt } from './roles';

export interface RunRequest {
  role: Role;
  runId: number;
  userPrompt: string;
  systemVars?: Record<string, string | number>;
  maxBudgetUsd: number;
  abort: AbortController;
  /** Executor only: per-run URL of the yard gateway. */
  yardUrl?: string;
  /** Executor only (mock mode drives the gateway directly). */
  mockContext?: unknown;
  onActivity: (a: { bubble?: string; progress?: number; estimateUsd?: number }) => void;
}

export interface RunUsage {
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionId: string | null;
}

export type RunOutcome =
  | ({ ok: true; output: unknown; fetchedUrls: string[] } & RunUsage)
  | ({ ok: false; status: 'error' | 'aborted' | 'budget_exceeded'; error: string; fetchedUrls: string[] } & RunUsage);

export function runAgent(req: RunRequest): Promise<RunOutcome> {
  if (config.MOCK_AGENTS) return runMock(req);
  return runReal(req);
}

export function bubbleForTool(name: string, input: Record<string, unknown>): string {
  if (name === 'WebSearch') return `Searching: ${String(input.query ?? '').slice(0, 60)}`;
  if (name === 'WebFetch') {
    try {
      return `Reading ${new URL(String(input.url)).hostname}`;
    } catch {
      return 'Reading a page';
    }
  }
  if (name.startsWith('mcp__yard__')) return `Using ${name.slice('mcp__yard__'.length).replace(/__/g, ' › ')}`;
  return `Using ${name}`;
}

export function firstLine(text: string, max = 80): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

async function runReal(req: RunRequest): Promise<RunOutcome> {
  const spec = ROLES[req.role];
  fs.mkdirSync(config.AGENT_CWD, { recursive: true });

  const allowedBuiltins = new Set(spec.builtinTools);
  // Second layer behind the restricted tool set: deny anything outside the
  // role's sandbox even if it somehow becomes visible to the model.
  // Yard calls are allowed here because the gateway itself applies the tier
  // policy, paper mode and approvals to every one of them.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (allowedBuiltins.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (spec.usesYard && toolName.startsWith('mcp__yard__')) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `Tool ${toolName} is not available to the ${req.role} role.` };
  };

  const options: Options = {
    model: spec.model,
    effort: spec.effort,
    maxTurns: spec.maxTurns,
    maxBudgetUsd: Math.max(0.01, req.maxBudgetUsd),
    abortController: req.abort,
    systemPrompt: systemPrompt(req.role, req.systemVars),
    tools: spec.builtinTools,
    allowedTools: spec.builtinTools,
    mcpServers: spec.usesYard && req.yardUrl ? { yard: { type: 'http', url: req.yardUrl, alwaysLoad: true } } : {},
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    cwd: config.AGENT_CWD,
    permissionMode: 'default',
    canUseTool,
    outputFormat: { type: 'json_schema', schema: outputJsonSchema(req.role) },
  };

  const usage: RunUsage = { costUsd: 0, numTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessionId: null };
  const fetchedUrls: string[] = [];
  let toolCalls = 0;
  let estimate = 0;
  const expectedTools = Math.max(4, Math.round(spec.maxTurns * 0.5));

  try {
    const q = query({ prompt: req.userPrompt, options });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        usage.sessionId = m.session_id;
        addRunEvent(req.runId, 'system', { model: m.model, tools: m.tools, mcp_servers: m.mcp_servers });
      } else if (m.type === 'assistant') {
        const u = m.message.usage as Parameters<typeof estimateCost>[1] | undefined;
        if (u) {
          estimate += estimateCost(spec.model, u);
          req.onActivity({ estimateUsd: estimate });
        }
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            addRunEvent(req.runId, 'assistant_text', { text: block.text });
            req.onActivity({ bubble: firstLine(block.text) });
          } else if (block.type === 'thinking' && 'thinking' in block && block.thinking) {
            addRunEvent(req.runId, 'thinking', { text: block.thinking });
          } else if (block.type === 'tool_use') {
            toolCalls++;
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (block.name === 'WebFetch' && typeof input.url === 'string') fetchedUrls.push(input.url);
            addRunEvent(req.runId, 'tool_use', { id: block.id, name: block.name, input });
            req.onActivity({ bubble: bubbleForTool(block.name, input), progress: Math.min(0.95, toolCalls / expectedTools) });
          } else if (block.type === 'server_tool_use') {
            toolCalls++;
            addRunEvent(req.runId, 'tool_use', { id: block.id, name: block.name, input: block.input });
          }
        }
      } else if (m.type === 'user') {
        const content = m.message.content;
        if (Array.isArray(content))
          for (const block of content)
            if (block.type === 'tool_result')
              addRunEvent(req.runId, 'tool_result', { tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content });
      } else if (m.type === 'result') {
        usage.costUsd = m.total_cost_usd;
        usage.numTurns = m.num_turns;
        usage.inputTokens = m.usage.input_tokens;
        usage.outputTokens = m.usage.output_tokens;
        usage.cacheReadTokens = m.usage.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = m.usage.cache_creation_input_tokens ?? 0;
        if (m.subtype === 'success') {
          addRunEvent(req.runId, 'result', { structured_output: m.structured_output, result: m.result, cost_usd: m.total_cost_usd });
          const parsed = outputSchema(req.role).safeParse(m.structured_output);
          if (!parsed.success) {
            return { ok: false, status: 'error', error: 'Output did not match schema: ' + parsed.error.message.slice(0, 500), fetchedUrls, ...usage };
          }
          return { ok: true, output: parsed.data, fetchedUrls, ...usage };
        }
        addRunEvent(req.runId, 'error', { subtype: m.subtype, errors: m.errors });
        const status = m.subtype === 'error_max_budget_usd' ? 'budget_exceeded' : 'error';
        return { ok: false, status, error: `${m.subtype}: ${m.errors.join('; ')}`.slice(0, 1000), fetchedUrls, ...usage };
      }
    }
    return { ok: false, status: 'error', error: 'Agent ended without a result', fetchedUrls, ...usage, costUsd: usage.costUsd || estimate };
  } catch (err) {
    const aborted = req.abort.signal.aborted;
    const msg = err instanceof Error ? err.message : String(err);
    addRunEvent(req.runId, 'error', { message: msg, aborted });
    // An aborted run never reports its cost; fall back to the streamed estimate.
    return { ok: false, status: aborted ? 'aborted' : 'error', error: aborted ? `Aborted: ${String(req.abort.signal.reason ?? '')}` : msg, fetchedUrls, ...usage, costUsd: usage.costUsd || estimate };
  }
}
