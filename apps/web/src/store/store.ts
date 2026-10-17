/**
 * Money Factory client store (zustand). The WebSocket stream is the source of
 * truth: the first message is a full `snapshot`, then incremental events are
 * folded in by `applyEvent`. REST calls never write here directly.
 *
 * Shape (read with `useFactory(s => s.xxx)`):
 *   connected       boolean                      WebSocket currently open
 *   ready           boolean                      a snapshot has been received
 *   settings        Settings | null
 *   liveEnabled     boolean                      server ENABLE_LIVE flag (phase 6)
 *   mock            boolean                      server runs MOCK_AGENTS
 *   maxWorkers      number                       worker slider max (from upgrades)
 *   agents          Record<number, Agent>        by agent id   (scene reads this)
 *   crates          Record<number, Crate>        by crate id   (scene reads this)
 *   opportunities   Record<number, Opportunity>  by opportunity id
 *   approvals       Record<number, Action>       pending_approval actions only, by action id
 *   feed            FeedItem[]                   oldest first, capped at FEED_CAP
 *   budget          Budget | null
 *   hud             HudStats | null
 *   upgrades        Upgrade[]
 *   runs            Record<number, Run>          runs seen via run.started/run.finished (recent, capped)
 *   runEvents       Record<number, RunEvent[]>   streamed transcript per run id (recent runs, capped)
 *   lastRunByAgent  Record<number, number>       agent id -> latest run id seen
 *   tick            number                       bumps on every event (cheap "something changed" signal)
 *
 * Actions: applyEvent(e), mergeRunEvents(runId, events), setConnected(b).
 */
import type {
  Action,
  Agent,
  Budget,
  Crate,
  FeedItem,
  HudStats,
  Opportunity,
  Run,
  RunEvent,
  ServerEvent,
  Settings,
  Upgrade,
} from '@mf/shared';
import { create } from 'zustand';
import { playSfx, type SfxName } from '../sfx';

export const FEED_CAP = 300;
const RUN_CAP = 60;
const RUN_EVENT_CAP = 500;

export interface FactoryState {
  connected: boolean;
  ready: boolean;
  settings: Settings | null;
  liveEnabled: boolean;
  mock: boolean;
  maxWorkers: number;
  agents: Record<number, Agent>;
  crates: Record<number, Crate>;
  opportunities: Record<number, Opportunity>;
  approvals: Record<number, Action>;
  feed: FeedItem[];
  budget: Budget | null;
  hud: HudStats | null;
  upgrades: Upgrade[];
  runs: Record<number, Run>;
  runEvents: Record<number, RunEvent[]>;
  lastRunByAgent: Record<number, number>;
  tick: number;

  setConnected: (c: boolean) => void;
  applyEvent: (e: ServerEvent) => void;
  mergeRunEvents: (runId: number, events: RunEvent[]) => void;
}

function byId<T extends { id: number }>(xs: T[]): Record<number, T> {
  const out: Record<number, T> = {};
  for (const x of xs) out[x.id] = x;
  return out;
}

/** Keep only the newest `cap` numeric keys of a record. */
function capKeys<T>(rec: Record<number, T>, cap: number): Record<number, T> {
  const keys = Object.keys(rec).map(Number);
  if (keys.length <= cap) return rec;
  keys.sort((a, b) => b - a);
  const out: Record<number, T> = {};
  for (const k of keys.slice(0, cap)) out[k] = rec[k];
  return out;
}

function mergeEvents(prev: RunEvent[] | undefined, incoming: RunEvent[]): RunEvent[] {
  const seen = new Map<number, RunEvent>();
  for (const e of prev ?? []) seen.set(e.seq, e);
  for (const e of incoming) seen.set(e.seq, e);
  const all = [...seen.values()].sort((a, b) => a.seq - b.seq);
  return all.length > RUN_EVENT_CAP ? all.slice(all.length - RUN_EVENT_CAP) : all;
}

export const useFactory = create<FactoryState>()((set, get) => ({
  connected: false,
  ready: false,
  settings: null,
  liveEnabled: false,
  mock: false,
  maxWorkers: 1,
  agents: {},
  crates: {},
  opportunities: {},
  approvals: {},
  feed: [],
  budget: null,
  hud: null,
  upgrades: [],
  runs: {},
  runEvents: {},
  lastRunByAgent: {},
  tick: 0,

  setConnected: (connected) => set({ connected }),

  mergeRunEvents: (runId, events) =>
    set((s) => ({ runEvents: capKeys({ ...s.runEvents, [runId]: mergeEvents(s.runEvents[runId], events) }, RUN_CAP) })),

  applyEvent: (e) => {
    const s = get();
    const cues: SfxName[] = [];
    const tick = s.tick + 1;
    switch (e.type) {
      case 'snapshot': {
        const d = e.data;
        set({
          ready: true,
          settings: d.settings,
          liveEnabled: d.live_enabled,
          mock: d.mock,
          maxWorkers: d.max_workers,
          agents: byId(d.agents),
          crates: byId(d.crates),
          opportunities: byId(d.opportunities),
          approvals: byId(d.approvals),
          feed: d.feed.slice(-FEED_CAP),
          budget: d.budget,
          hud: d.hud,
          upgrades: d.upgrades,
          tick,
        });
        return;
      }
      case 'agent.updated':
        set({ agents: { ...s.agents, [e.data.id]: e.data }, tick });
        break;
      case 'run.started':
      case 'run.finished': {
        const run = e.data;
        set({
          runs: capKeys({ ...s.runs, [run.id]: run }, RUN_CAP),
          lastRunByAgent: { ...s.lastRunByAgent, [run.agent_id]: Math.max(run.id, s.lastRunByAgent[run.agent_id] ?? 0) },
          tick,
        });
        break;
      }
      case 'run.event':
        set({
          runEvents: capKeys({ ...s.runEvents, [e.data.run_id]: mergeEvents(s.runEvents[e.data.run_id], [e.data]) }, RUN_CAP),
        });
        return; // no tick: transcript chunks are frequent
      case 'crate.updated': {
        const prev = s.crates[e.data.id];
        if (!prev && e.data.source === 'user') cues.push('drop');
        if (e.data.stage === 'vault' && prev && prev.stage !== 'vault') cues.push('vaulted');
        if (e.data.stage === 'scrap' && prev && prev.stage !== 'scrap') cues.push('scrapped');
        set({ crates: { ...s.crates, [e.data.id]: e.data }, tick });
        break;
      }
      case 'opportunity.updated':
        set({ opportunities: { ...s.opportunities, [e.data.id]: e.data }, tick });
        break;
      case 'approval.updated':
      case 'action.recorded': {
        const a = e.data;
        const approvals = { ...s.approvals };
        if (a.status === 'pending_approval') {
          if (!approvals[a.id]) cues.push('approval');
          approvals[a.id] = a;
        } else delete approvals[a.id];
        set({ approvals, tick });
        break;
      }
      case 'budget.updated':
        set({ budget: e.data, tick });
        break;
      case 'hud.updated':
        set({ hud: e.data, tick });
        break;
      case 'feed.event': {
        if (s.feed.some((f) => f.id === e.data.id)) return;
        const feed = [...s.feed, e.data];
        set({ feed: feed.length > FEED_CAP ? feed.slice(feed.length - FEED_CAP) : feed, tick });
        break;
      }
      case 'settings.updated':
        if (e.data.kill_switch && s.settings && !s.settings.kill_switch) cues.push('kill');
        set({ settings: e.data, tick });
        break;
      case 'xp.awarded':
        set({ tick });
        break;
      case 'upgrade.unlocked': {
        const ups = s.upgrades.some((u) => u.key === e.data.key)
          ? s.upgrades.map((u) => (u.key === e.data.key ? e.data : u))
          : [...s.upgrades, e.data];
        cues.push('vaulted');
        set({ upgrades: ups, tick });
        break;
      }
    }
    const muted = get().settings?.muted ?? true;
    if (!muted) for (const c of new Set(cues)) playSfx(c);
  },
}));

// ------------------------------------------------------------------ selectors

export const STAGES = ['dock', 'research', 'market', 'validation', 'vault', 'scrap', 'execution'] as const;

export function cratesByStage(crates: Record<number, Crate>): Record<string, Crate[]> {
  const out: Record<string, Crate[]> = {};
  for (const st of STAGES) out[st] = [];
  for (const c of Object.values(crates)) (out[c.stage] ??= []).push(c);
  for (const st of Object.keys(out))
    out[st].sort((a, b) => b.priority - a.priority || (a.created_at < b.created_at ? -1 : 1));
  return out;
}
