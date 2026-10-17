import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../config';
import { db } from '../db/db';
import { feed, upsertTool } from '../db/repo';
import { audit } from '../safety/audit';
import { mapTool } from './tiers';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  /** Which built-in tier map to use: "paybox", "agentmail", or anything else for pattern matching. */
  profile?: string;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface Upstream {
  name: string;
  cfg: ServerConfig;
  client: Client | null;
  tools: UpstreamTool[];
  error: string | null;
}

const upstreams = new Map<string, Upstream>();

function interpolate<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? '') as T;
  if (Array.isArray(value)) return value.map(interpolate) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)])) as T;
  return value;
}

function mockServers(): Record<string, ServerConfig> {
  const tsx = ['--import', 'tsx'];
  return {
    paybox: { profile: 'paybox', type: 'stdio', command: process.execPath, args: [...tsx, path.join(here, '../mock/walletMcp.ts')] },
    agentmail: { profile: 'agentmail', type: 'stdio', command: process.execPath, args: [...tsx, path.join(here, '../mock/emailMcp.ts')] },
  };
}

export function loadServerConfigs(): Record<string, ServerConfig> {
  if (fs.existsSync(config.MCP_CONFIG)) {
    const raw = JSON.parse(fs.readFileSync(config.MCP_CONFIG, 'utf8')) as { servers?: Record<string, ServerConfig> };
    return interpolate(raw.servers ?? {});
  }
  // No config file: in mock mode use the bundled fake wallet and inbox.
  return config.MOCK_AGENTS ? mockServers() : {};
}

async function connect(name: string, cfg: ServerConfig): Promise<Upstream> {
  const up: Upstream = { name, cfg, client: null, tools: [], error: null };
  try {
    const client = new Client({ name: 'money-factory-yard', version: '0.1.0' });
    if ((cfg.type ?? (cfg.url ? 'http' : 'stdio')) === 'http') {
      if (!cfg.url) throw new Error('http server needs a url');
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } }));
    } else {
      if (!cfg.command) throw new Error('stdio server needs a command');
      await client.connect(
        new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) }, stderr: 'ignore' }),
      );
    }
    const { tools } = await client.listTools();
    up.client = client;
    up.tools = tools as UpstreamTool[];
    for (const t of up.tools) {
      const schema = JSON.stringify(t.inputSchema ?? {});
      const m = mapTool(cfg.profile, t.name);
      const result = upsertTool({
        server: name,
        tool: t.name,
        description: t.description ?? null,
        input_schema: schema,
        schema_hash: crypto.createHash('sha256').update(schema + (t.description ?? '')).digest('hex'),
        tier: m.tier,
        classifier: m.classifier,
      });
      if (result === 'new') {
        audit('system', 'tool_discovered', `${name}/${t.name}`, { tier: m.tier, classifier: m.classifier, exact: m.exact });
        if (m.exact) {
          // Exact matches to the built-in map are usable immediately; pattern
          // guesses stay blocked until the owner confirms them in Settings.
          markReviewed(name, t.name);
        } else feed('warn', `New tool ${name}/${t.name} found. It's blocked until you review its tier in Settings.`);
      }
    }
  } catch (err) {
    up.error = err instanceof Error ? err.message : String(err);
    feed('bad', `Could not connect MCP server "${name}": ${up.error}`);
  }
  return up;
}

function markReviewed(server: string, tool: string) {
  // The tool_discovered audit row above records why this was auto-reviewed.
  db.prepare('UPDATE mcp_tools SET reviewed = 1 WHERE server = ? AND tool = ?').run(server, tool);
}

export async function connectAll() {
  await closeAll();
  const cfgs = loadServerConfigs();
  for (const [name, cfg] of Object.entries(cfgs)) upstreams.set(name, await connect(name, cfg));
  const ok = [...upstreams.values()].filter((u) => u.client);
  if (ok.length) feed('info', `Execution Yard connected to ${ok.map((u) => `${u.name} (${u.tools.length} tools)`).join(', ')}.`);
}

export async function closeAll() {
  for (const u of upstreams.values()) await u.client?.close().catch(() => {});
  upstreams.clear();
}

export function upstreamStatus() {
  return [...upstreams.values()].map((u) => ({ name: u.name, profile: u.cfg.profile ?? null, connected: !!u.client, tools: u.tools.length, error: u.error }));
}

export function upstreamTools(): Array<{ server: string; profile?: string; tool: UpstreamTool }> {
  const out: Array<{ server: string; profile?: string; tool: UpstreamTool }> = [];
  for (const u of upstreams.values()) if (u.client) for (const t of u.tools) out.push({ server: u.name, profile: u.cfg.profile, tool: t });
  return out;
}

export function profileOf(server: string): string | undefined {
  return upstreams.get(server)?.cfg.profile;
}

export function findServerByProfile(profile: string): string | undefined {
  for (const u of upstreams.values()) if (u.cfg.profile === profile && u.client) return u.name;
  return undefined;
}

export interface UpstreamResult {
  isError: boolean;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
}

export async function callUpstream(server: string, tool: string, args: Record<string, unknown>): Promise<UpstreamResult> {
  const u = upstreams.get(server);
  if (!u?.client) throw new Error(`MCP server ${server} is not connected`);
  const res = await u.client.callTool({ name: tool, arguments: args });
  return res as unknown as UpstreamResult;
}

export function resultText(r: UpstreamResult): string {
  return r.content.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
}

/** Best-effort JSON view of a tool result (structuredContent or JSON text). */
export function resultJson(r: UpstreamResult): unknown {
  if (r.structuredContent) return r.structuredContent;
  const text = resultText(r);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
