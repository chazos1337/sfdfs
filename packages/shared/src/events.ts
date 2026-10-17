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
  Settings,
  Snapshot,
  Upgrade,
} from './types';

// Every message the server pushes over the WebSocket.
export type ServerEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'agent.updated'; data: Agent }
  | { type: 'run.started'; data: Run }
  | { type: 'run.event'; data: RunEvent }
  | { type: 'run.finished'; data: Run }
  | { type: 'crate.updated'; data: Crate }
  | { type: 'opportunity.updated'; data: Opportunity }
  | { type: 'approval.updated'; data: Action }
  | { type: 'action.recorded'; data: Action }
  | { type: 'budget.updated'; data: Budget }
  | { type: 'hud.updated'; data: HudStats }
  | { type: 'feed.event'; data: FeedItem }
  | { type: 'settings.updated'; data: Settings }
  | { type: 'xp.awarded'; data: { agent_id: number; amount: number; reason: string } }
  | { type: 'upgrade.unlocked'; data: Upgrade };

export type ServerEventType = ServerEvent['type'];
