import type { HudStats, Snapshot } from '@mf/shared';
import { config } from './config';
import { db, today } from './db/db';
import { getKv, getSettings, listAgents, listCrates, listFeed, listOpportunities, pendingApprovals, pnlByOpportunity } from './db/repo';
import { listUpgrades, maxWorkers } from './game/upgrades';
import { activeRuns } from './runtime';
import { budget } from './safety/budget';

export function hudStats(): HudStats {
  const recent = db
    .prepare("SELECT updated_at FROM crates WHERE stage IN ('vault','scrap') AND status = 'done' AND updated_at >= ?")
    .all(new Date(Date.now() - 36 * 3600_000).toISOString()) as Array<{ updated_at: string }>;
  const day = today();
  return {
    active_workers: activeRuns.size,
    ideas_processed_today: recent.filter((r) => today(new Date(r.updated_at)) === day).length,
    vault_count: (db.prepare('SELECT COUNT(*) n FROM opportunities').get() as { n: number }).n,
    wallet_balance_usd: getKv<number | null>('wallet_balance_usd', null),
    pnl: pnlByOpportunity(),
  };
}

export function snapshot(): Snapshot {
  return {
    settings: getSettings(),
    live_enabled: config.ENABLE_LIVE,
    mock: config.MOCK_AGENTS,
    max_workers: maxWorkers(),
    agents: listAgents(),
    crates: listCrates(),
    opportunities: listOpportunities(),
    approvals: pendingApprovals(),
    budget: budget(),
    hud: hudStats(),
    feed: listFeed(150),
    upgrades: listUpgrades(),
  };
}
