import { callUpstream, resultJson } from './mcpClients';

// The gateway works out the USD value of a money-moving call itself, from a
// fresh balance read, and never trusts a value the agent supplies. If it
// can't price the call, the policy treats it as unknown → owner approval.

const SOLANA_NETWORK_ID = 1399811149;

export function networkIdForChain(chain: string | undefined): number | null {
  if (!chain) return null;
  const c = chain.toLowerCase();
  if (c === 'solana' || c === 'sol' || c.startsWith('solana:')) return SOLANA_NETWORK_ID;
  if (c === 'evm' || c === 'eth' || c === 'ethereum') return 1;
  const m = /^eip155:(\d+)$/.exec(c);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(c)) return Number(c);
  return null;
}

interface Holding {
  balance: number;
  usd: number;
}

const USD_KEYS = ['balanceUsd', 'balance_usd', 'usdValue', 'usd_value', 'valueUsd', 'value_usd', 'usd'];

function findHolding(data: unknown): Holding | null {
  const items: unknown[] = Array.isArray(data)
    ? data
    : ((data as { items?: unknown[]; holdings?: unknown[] })?.items ?? (data as { holdings?: unknown[] })?.holdings ?? []);
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const row = it as Record<string, unknown>;
    const balance = Number(row.balance ?? row.raw_balance ?? NaN);
    const usdKey = USD_KEYS.find((k) => row[k] !== undefined && row[k] !== null);
    const usd = usdKey ? Number(row[usdKey]) : NaN;
    if (Number.isFinite(balance) && balance > 0 && Number.isFinite(usd)) return { balance, usd };
  }
  return null;
}

const cache = new Map<string, { at: number; perUnit: number | null }>();

/** USD value of `amount` smallest units of `token` on `chain`, or null if unknown. */
export async function usdValue(server: string, args: { chain?: string; token?: string | null; amount?: string | number }): Promise<number | null> {
  const networkId = networkIdForChain(args.chain);
  const amount = Number(args.amount);
  if (networkId === null || !Number.isFinite(amount) || amount < 0) return null;
  const token = args.token && args.token !== '' ? args.token : 'native';
  const key = `${server}|${networkId}|${token}`;
  const hit = cache.get(key);
  let perUnit: number | null;
  if (hit && Date.now() - hit.at < 60_000) perUnit = hit.perUnit;
  else {
    try {
      const res = await callUpstream(server, 'get_portfolio', { token, network_id: networkId });
      const h = res.isError ? null : findHolding(resultJson(res));
      perUnit = h ? h.usd / h.balance : null;
    } catch {
      perUnit = null;
    }
    cache.set(key, { at: Date.now(), perUnit });
  }
  return perUnit === null ? null : amount * perUnit;
}

/** Strip attacker-controllable token labels down to something harmless. */
export function sanitizeLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLabels);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'name' || k === 'symbol' || k === 'wallet_name') && typeof v === 'string') out[k] = v.replace(/[^A-Za-z0-9 .\-]/g, '').slice(0, 24);
      else out[k] = sanitizeLabels(v);
    }
    return out;
  }
  return value;
}
