import type { Upgrade } from '@mf/shared';
import { bus } from '../bus';
import { db, now } from '../db/db';
import { feed, realizedLiveRevenue } from '../db/repo';
import { audit } from '../safety/audit';

// Upgrades unlock from real milestones only: ideas that actually reached the
// vault, crates actually processed, money actually earned in live mode.

interface Def {
  key: string;
  name: string;
  description: string;
  milestone: string;
  progress: () => number;
}

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const vaulted = () => count('SELECT COUNT(*) n FROM opportunities');
const processed = () => count("SELECT COUNT(*) n FROM crates WHERE stage IN ('vault','scrap') AND status = 'done'");

const DEFS: Def[] = [
  { key: 'second_shift', name: 'Second Shift', description: 'Worker limit 3 → 5', milestone: '5 ideas in the Vault', progress: () => vaulted() / 5 },
  { key: 'turbo_scanner', name: 'Turbo Scanner', description: 'Scout can run every 10 min and bring up to 5 crates', milestone: '25 ideas processed', progress: () => processed() / 25 },
  { key: 'third_shift', name: 'Third Shift', description: 'Worker limit 5 → 8', milestone: '15 ideas in the Vault', progress: () => vaulted() / 15 },
  { key: 'treasury', name: 'Treasury', description: 'Per-action cap can go above $25', milestone: 'First $1 of live revenue', progress: () => realizedLiveRevenue() / 1 },
];

function unlockedKeys(): Map<string, string> {
  const rows = db.prepare('SELECT key, unlocked_at FROM upgrades').all() as Array<{ key: string; unlocked_at: string }>;
  return new Map(rows.map((r) => [r.key, r.unlocked_at]));
}

export function hasUpgrade(key: string): boolean {
  return unlockedKeys().has(key);
}

export function listUpgrades(): Upgrade[] {
  const unlocked = unlockedKeys();
  return DEFS.map((d) => ({
    key: d.key,
    name: d.name,
    description: d.description,
    milestone: d.milestone,
    unlocked_at: unlocked.get(d.key) ?? null,
    progress: Math.min(1, d.progress()),
  }));
}

export function checkUpgrades() {
  const unlocked = unlockedKeys();
  for (const d of DEFS) {
    if (unlocked.has(d.key) || d.progress() < 1) continue;
    db.prepare('INSERT INTO upgrades (key, unlocked_at) VALUES (?, ?)').run(d.key, now());
    audit('system', 'upgrade_unlocked', d.key, { milestone: d.milestone });
    feed('good', `Upgrade unlocked: ${d.name} (${d.description})`);
    const u = listUpgrades().find((x) => x.key === d.key)!;
    bus.publish({ type: 'upgrade.unlocked', data: u });
  }
}

export function maxWorkers(): number {
  return hasUpgrade('third_shift') ? 8 : hasUpgrade('second_shift') ? 5 : 3;
}

export function scoutLimits(): { minIntervalMin: number; maxBatch: number } {
  return hasUpgrade('turbo_scanner') ? { minIntervalMin: 10, maxBatch: 5 } : { minIntervalMin: 30, maxBatch: 3 };
}

export function maxPerActionCap(): number {
  return hasUpgrade('treasury') ? 250 : 25;
}
