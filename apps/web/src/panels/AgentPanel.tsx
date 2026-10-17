import type { RunEvent } from '@mf/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type RunRow, type SourceRow } from '../net/api';
import { useFactory } from '../store/store';
import { useUi } from '../store/ui';
import { levelInfo, STAGE_LABEL, STATE_COLOR, truncate, usd } from '../util';
import { Badge, Bar, Empty, ExtLink, Label, StatusBadge } from './ui';

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : JSON.stringify(b))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

function inputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const o = input as Record<string, unknown>;
  for (const k of ['query', 'url', 'to', 'amount', 'prompt']) if (o[k] != null) return `${k}: ${typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k])}`;
  return truncate(JSON.stringify(o), 160);
}

const ROLE_COLOR: Record<string, string> = { scout: '#5ad1d1', research: '#6cb6ff', market: '#6fdc8c', validation: '#c792ea', planner: '#ffd166', executor: '#ff8f3f' };

function StreamItem({ e }: { e: RunEvent }) {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'assistant_text':
      return <div className="whitespace-pre-wrap text-[12px] leading-snug text-ink-100">{String(p.text ?? '')}</div>;
    case 'thinking':
      return <div className="whitespace-pre-wrap border-l-2 border-[#c792ea] pl-2 text-[11px] italic leading-snug text-ink-300">{truncate(String(p.text ?? p.thinking ?? ''), 600)}</div>;
    case 'tool_use':
      return (
        <div className="border-2 border-ink-700 bg-ink-950 px-2 py-1 text-[11px]">
          <span className="font-pixel text-[10px] text-info">⚒ {String(p.name ?? 'tool').replace(/^mcp__yard__/, 'yard › ')}</span>
          <div className="truncate font-mono text-ink-200" title={JSON.stringify(p.input)}>
            {inputSummary(p.input)}
          </div>
        </div>
      );
    case 'tool_result': {
      const txt = contentText(p.content);
      return (
        <div className={`ml-3 border-l-2 pl-2 font-mono text-[10px] leading-snug ${p.is_error ? 'border-bad text-bad' : 'border-ink-600 text-ink-300'}`} title={truncate(txt, 2000)}>
          ↳ {truncate(txt.replace(/\s+/g, ' '), 220) || '(empty)'}
        </div>
      );
    }
    case 'result':
      return <div className="font-pixel text-[10px] text-good">✓ Result {p.cost_usd != null ? `· ${usd(Number(p.cost_usd), 4)}` : ''}</div>;
    case 'error':
      return <div className="text-[11px] text-bad">✕ {String(p.message ?? JSON.stringify(p.errors ?? p))}</div>;
    case 'system':
      return <div className="text-[10px] text-ink-400">● session · model {String(p.model ?? '?')} · tools {Array.isArray(p.tools) ? (p.tools as string[]).join(', ') : ''}</div>;
    default:
      return null;
  }
}

export default function AgentPanel({ agentId }: { agentId: number }) {
  const agent = useFactory((s) => s.agents[agentId]);
  const crates = useFactory((s) => s.crates);
  const opps = useFactory((s) => s.opportunities);
  const liveRuns = useFactory((s) => s.runs);
  const lastRun = useFactory((s) => s.lastRunByAgent[agentId]);
  const runEvents = useFactory((s) => s.runEvents);
  const mergeRunEvents = useFactory((s) => s.mergeRunEvents);
  const selectAgent = useUi((s) => s.selectAgent);
  const openCrate = useUi((s) => s.openCrate);
  const openOpportunity = useUi((s) => s.openOpportunity);

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [tab, setTab] = useState<'stream' | 'sources' | 'runs'>('stream');
  const streamRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const runId = agent?.current_run_id ?? lastRun ?? runs[0]?.id ?? null;
  const finishedRun = runId ? liveRuns[runId]?.status : undefined;

  // Load agent detail on select, whenever its run changes and when that run finishes.
  useEffect(() => {
    let cancelled = false;
    void api
      .agent(agentId)
      .then(async (d) => {
        if (cancelled) return;
        setRuns(d.runs);
        const rid = d.current_run?.id ?? d.runs[0]?.id;
        if (d.current_run) {
          mergeRunEvents(d.current_run.id, d.events);
          setSources(d.sources);
        } else if (rid) {
          const r = await api.run(rid);
          if (cancelled) return;
          mergeRunEvents(rid, r.events);
          setSources(r.sources);
        } else setSources([]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, agent?.current_run_id, finishedRun, mergeRunEvents]);

  const events = useMemo(() => (runId ? (runEvents[runId] ?? []) : []), [runEvents, runId]);

  useEffect(() => {
    const el = streamRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, tab]);

  const fetched = useMemo(() => {
    const urls = new Set<string>();
    for (const e of events) {
      const p = e.payload as { name?: string; input?: { url?: string } } | null;
      if (e.type === 'tool_use' && p?.name === 'WebFetch' && p.input?.url) urls.add(p.input.url);
    }
    return [...urls];
  }, [events]);
  const toolCalls = events.filter((e) => e.type === 'tool_use');

  if (!agent) return <Empty>Agent not found.</Empty>;
  const lv = levelInfo(agent.xp);
  const crate = agent.current_crate_id ? crates[agent.current_crate_id] : null;
  const opp = agent.current_opportunity_id ? opps[agent.current_opportunity_id] : null;
  const run = runs.find((r) => r.id === runId) ?? (runId ? liveRuns[runId] : undefined);
  const liveRun = runId ? liveRuns[runId] : undefined;
  const shownRun = liveRun && (!run || liveRun.status !== 'running' || run.status === 'running') ? { ...run, ...liveRun } : run;
  const totalCost = runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const totalIn = runs.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
  const totalOut = runs.reduce((a, r) => a + (r.output_tokens ?? 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-start gap-3 border-b-2 border-ink-700 p-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center border-[3px] border-black" style={{ background: agent.palette, boxShadow: '3px 3px 0 rgba(0,0,0,.5)' }}>
          <span className="font-pixel text-[16px] text-black/70">{agent.name[0]}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-pixel text-[15px] uppercase text-ink-100">{agent.name}</span>
            <Badge color="#ffd166">Lv {lv.level}</Badge>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Bar value={lv.progress} color="#ffd166" segments={10} height={6} className="flex-1" />
            <span className="shrink-0 text-[10px] text-ink-300">
              {agent.xp}/{lv.next} xp
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            <Badge color={STATE_COLOR[agent.state]}>{agent.state.replace('_', ' ')}</Badge>
            <span className="text-ink-300">@ {STAGE_LABEL[agent.building]}</span>
            <span className="text-ink-400">· {agent.ideas_vaulted} vaulted</span>
          </div>
        </div>
        <button className="px-btn" onClick={() => selectAgent(null)} aria-label="Close agent panel">
          ✕
        </button>
      </div>

      {/* current task */}
      <div className="border-b-2 border-ink-700 px-3 py-2">
        <Label>Current task</Label>
        {agent.current_role ? (
          <div className="mt-1 flex items-center gap-2 text-[12px]">
            <Badge color={ROLE_COLOR[agent.current_role]}>{agent.current_role}</Badge>
            {crate && (
              <button className="min-w-0 truncate text-left text-ink-100 underline decoration-dotted hover:text-gold" onClick={() => openCrate(crate.id)}>
                #{crate.id} {crate.title}
              </button>
            )}
            {opp && (
              <button className="min-w-0 truncate text-left text-ink-100 underline decoration-dotted hover:text-gold" onClick={() => openOpportunity(opp.id)}>
                ◆ {opp.title}
              </button>
            )}
            {!crate && !opp && <span className="text-ink-300">{agent.current_role === 'scout' ? 'Scouting for new ideas' : '—'}</span>}
          </div>
        ) : (
          <div className="mt-1 text-[12px] italic text-ink-400">{agent.state === 'clocked_out' ? 'Clocked out.' : 'Waiting for work.'}</div>
        )}
        {agent.progress != null && <Bar value={agent.progress} color="#6cb6ff" segments={20} height={4} className="mt-1" />}
        {shownRun && (
          <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-ink-300">
            <span>
              run #{shownRun.id} <StatusBadge status={shownRun.status ?? 'running'} />
            </span>
            <span>
              tokens {shownRun.input_tokens ?? 0}↓ {shownRun.output_tokens ?? 0}↑
            </span>
            <span>cost {usd(shownRun.cost_usd ?? null, 4)}</span>
          </div>
        )}
      </div>

      {/* tabs */}
      <div className="flex border-b-2 border-ink-700">
        {(
          [
            ['stream', `Reasoning`],
            ['sources', `Sources ${sources.length + fetched.length ? `(${new Set([...sources.map((s) => s.url), ...fetched]).size})` : ''}`],
            ['runs', `Runs (${runs.length})`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`flex-1 px-2 py-1 font-pixel text-[10px] uppercase ${tab === k ? 'bg-ink-700 text-gold' : 'text-ink-300 hover:text-ink-100'}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'stream' && (
        <div
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-ink-900 p-2"
        >
          {events.length === 0 && <Empty>No transcript yet. Pick a busy worker to watch it think.</Empty>}
          {events.map((e) => (
            <StreamItem key={`${e.run_id}:${e.seq}`} e={e} />
          ))}
          {agent.current_run_id === runId && agent.state !== 'idle' && <div className="blink font-pixel text-[11px] text-ink-300">▌</div>}
        </div>
      )}

      {tab === 'sources' && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-[12px]">
          {sources.length === 0 && fetched.length === 0 && <Empty>No sources for this run yet.</Empty>}
          {sources.map((s) => (
            <div key={s.id}>
              <ExtLink href={s.url}>{s.title || s.url}</ExtLink>
              {s.claim && <div className="text-[11px] text-ink-300">{s.claim}</div>}
            </div>
          ))}
          {fetched.filter((u) => !sources.some((s) => s.url === u)).length > 0 && (
            <>
              <Label className="pt-2">Pages read</Label>
              {fetched
                .filter((u) => !sources.some((s) => s.url === u))
                .map((u) => (
                  <div key={u}>
                    <ExtLink href={u} />
                  </div>
                ))}
            </>
          )}
          <Label className="pt-2">Tool calls ({toolCalls.length})</Label>
          {toolCalls.map((e) => {
            const p = e.payload as { name?: string; input?: unknown };
            return (
              <div key={e.seq} className="truncate font-mono text-[11px] text-ink-200">
                {String(p.name ?? '').replace(/^mcp__yard__/, 'yard › ')} <span className="text-ink-400">{inputSummary(p.input)}</span>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'runs' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="mb-2 flex gap-3 px-1 text-[11px] text-ink-300">
            <span>Total {usd(totalCost, 4)}</span>
            <span>
              {totalIn.toLocaleString()} in / {totalOut.toLocaleString()} out tokens
            </span>
          </div>
          <table className="w-full text-[11px]">
            <thead className="text-left font-pixel text-[9px] uppercase text-ink-400">
              <tr>
                <th>#</th>
                <th>Role</th>
                <th>Status</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-ink-700">
                  <td className="py-0.5">
                    {r.crate_id ? (
                      <button className="underline decoration-dotted hover:text-gold" onClick={() => openCrate(r.crate_id!)}>
                        {r.id}
                      </button>
                    ) : (
                      r.id
                    )}
                  </td>
                  <td>{r.role}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="text-right text-ink-300">{((r.input_tokens ?? 0) + (r.output_tokens ?? 0)).toLocaleString()}</td>
                  <td className="text-right">{usd(r.cost_usd, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
