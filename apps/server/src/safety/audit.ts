import crypto from 'node:crypto';
import { db, now } from '../db/db';

const GENESIS = '0'.repeat(64);

function hashRow(prev: string, ts: string, actor: string, kind: string, ref: string | null, data: string) {
  return crypto.createHash('sha256').update([prev, ts, actor, kind, ref ?? '', data].join('␟')).digest('hex');
}

/**
 * Append one entry to the tamper-evident audit log. Every row stores the hash
 * of the previous row, so editing or removing anything outside the app breaks
 * the chain (see verifyAudit). UPDATE/DELETE are also blocked by triggers.
 */
export function audit(actor: string, kind: string, ref: string | null, data: unknown): number {
  const insert = db.transaction(() => {
    const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const prev = last?.hash ?? GENESIS;
    const ts = now();
    const dataJson = JSON.stringify(data ?? null);
    const hash = hashRow(prev, ts, actor, kind, ref, dataJson);
    const info = db
      .prepare('INSERT INTO audit_log (ts, actor, kind, ref, data_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?)')
      .run(ts, actor, kind, ref, dataJson, prev, hash);
    return Number(info.lastInsertRowid);
  });
  return insert();
}

export function verifyAudit(): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').iterate() as IterableIterator<{
    id: number;
    ts: string;
    actor: string;
    kind: string;
    ref: string | null;
    data_json: string;
    prev_hash: string;
    hash: string;
  }>;
  let prev = GENESIS;
  let checked = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev || hashRow(prev, r.ts, r.actor, r.kind, r.ref, r.data_json) !== r.hash) {
      return { ok: false, checked, brokenAt: r.id };
    }
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked };
}

export function listAudit(opts: { before?: number; limit?: number; kind?: string }) {
  const limit = Math.min(opts.limit ?? 100, 500);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.before) {
    where.push('id < ?');
    args.push(opts.before);
  }
  if (opts.kind) {
    where.push('kind = ?');
    args.push(opts.kind);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}
