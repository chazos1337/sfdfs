import type { Mode, Plan, PlanStep, Tier } from '@mf/shared';
import {
  actionTypeSeen,
  emailsSentRecently,
  getSettings,
  getTool,
  isAllowlisted,
  spentToday,
} from '../db/repo';
import { inspectCalldata, isPermitTypedData } from './decoders/evm';
import { usdValue } from './pricing';

export interface CallContext {
  runId: number | null;
  opportunityId: number | null;
  mode: Mode;
  tainted: boolean;
  plan: Plan | null;
  stepId: string | null;
}

export interface Decision {
  tier: Tier;
  reasons: string[];
  amountUsd: number | null;
  recipient: string | null;
  /** Reading this result puts third-party text in front of the agent. */
  taints: boolean;
  /** Token/wallet labels in the result must be sanitized. */
  sanitize: boolean;
  classifier: string | null;
}

/** Which plan step kinds a tool family may serve. */
const STEP_KINDS_FOR: Record<string, PlanStep['kind'][]> = {
  transfer: ['transfer'],
  swap: ['swap'],
  x402: ['x402_call'],
  card: ['card_purchase'],
  email_send: ['email_send'],
  email_reply: ['email_send'],
  sign: ['transfer', 'swap', 'x402_call'],
};

function emails(v: unknown): string[] {
  if (!v) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((x) => String(x).split(',')).map((s) => s.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1')).filter(Boolean);
}

function emailAllowed(addr: string) {
  const domain = addr.split('@')[1] ?? '';
  return isAllowlisted('email_address', addr) || (domain !== '' && isAllowlisted('email_domain', domain));
}

function hostOf(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function raise(d: Decision, tier: Tier, reason: string) {
  if (tier > d.tier) d.tier = tier;
  d.reasons.push(reason);
}

/**
 * Decide the tier of one concrete tool call. The stored tier is the floor;
 * everything below can only raise it. Tier 1 survives only if every limit
 * check passes.
 */
export async function evaluate(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: CallContext,
  extra: { quotedUsd?: number | null } = {},
): Promise<Decision> {
  const row = getTool(server, tool);
  const d: Decision = { tier: 0, reasons: [], amountUsd: null, recipient: null, taints: false, sanitize: false, classifier: row?.classifier ?? null };
  if (!row) {
    raise(d, 3, 'unknown tool');
    return d;
  }
  if (!row.reviewed) {
    raise(d, 3, 'tool not reviewed by owner yet');
    return d;
  }
  d.tier = row.tier as Tier;
  if (row.tier === 3) {
    d.reasons.push('tool is blocked (tier 3)');
    return d;
  }
  d.reasons.push(`base tier ${row.tier}`);
  const s = getSettings();

  switch (row.classifier) {
    case 'portfolio':
      d.sanitize = true;
      break;
    case 'untrusted_read':
    case 'email_read':
      d.taints = true;
      break;
    case 'transfer': {
      const chain = String(args.chain ?? '');
      const to = String(args.to ?? '');
      d.recipient = to || null;
      if (args.dst_chain && args.dst_chain !== chain) raise(d, 3, 'cross-chain transfer (bridge)');
      d.amountUsd = await usdValue(server, { chain, token: (args.token as string | null) ?? null, amount: args.amount as string });
      if (!to) raise(d, 2, 'no recipient');
      else if (!isAllowlisted('wallet_address', to, chain)) raise(d, 2, `new recipient ${to}`);
      break;
    }
    case 'swap': {
      const src = String(args.src_chain ?? '');
      const dst = args.dst_chain ? String(args.dst_chain) : src;
      if (dst && src && dst !== src) raise(d, 3, `bridging ${src} → ${dst} is blocked`);
      else raise(d, 2, 'swaps always need approval');
      d.amountUsd = await usdValue(server, { chain: src, token: args.src_token as string, amount: args.amount as string });
      if (args.recipient) d.recipient = String(args.recipient);
      break;
    }
    case 'x402': {
      const host = hostOf(args.url ?? args.resource_url);
      d.recipient = host;
      if (tool === 'use_service' && String(args.mode ?? '') === 'probe') {
        d.tier = 0;
        d.reasons.push('unpaid probe');
        d.taints = true;
        break;
      }
      d.taints = true;
      if (!host || !isAllowlisted('x402_host', host)) raise(d, 2, `new paid host ${host ?? '?'}`);
      // Price comes from the gateway's own unpaid probe of the 402 quote.
      d.amountUsd = extra.quotedUsd ?? null;
      break;
    }
    case 'sign': {
      const intent = (args.intent ?? {}) as Record<string, unknown>;
      const op = String(intent.op ?? '');
      if (op === 'raw') raise(d, 3, 'raw digest signing is blocked');
      else if (op === 'authorization') raise(d, 3, 'EIP-7702 authorization (account delegation) is blocked');
      else if (op === 'typedData' && isPermitTypedData(intent.typedData)) raise(d, 3, 'permit / allowance typed data is blocked');
      else if (op === 'transaction') {
        const tx = (intent.transaction ?? {}) as Record<string, unknown>;
        const dec = inspectCalldata(tx.data);
        if (dec.dangerous) raise(d, 3, dec.reason ?? 'dangerous calldata');
        else raise(d, 2, dec.method ? `contract call ${dec.method}` : 'transaction signature');
        if (tx.to) d.recipient = String(tx.to);
      } else raise(d, 2, `signature (${op || 'unknown op'})`);
      break;
    }
    case 'card':
      d.recipient = String(args.merchant ?? args.merchant_url ?? '') || null;
      d.amountUsd = Number.isFinite(Number(args.amount_cents)) ? Number(args.amount_cents) / 100 : null;
      raise(d, 2, 'card purchases need approval');
      break;
    case 'email_send': {
      const all = [...emails(args.to), ...emails(args.cc), ...emails(args.bcc)];
      d.recipient = all.join(', ') || null;
      if (!all.length) raise(d, 2, 'no recipients');
      const outside = all.filter((a) => !emailAllowed(a));
      if (outside.length) raise(d, 2, `recipients not allowlisted: ${outside.join(', ')}`);
      if (Array.isArray(args.attachments) && args.attachments.length) raise(d, 2, 'email has attachments');
      if (emailsSentRecently(ctx.mode) >= s.daily_email_cap) raise(d, 2, `daily email cap (${s.daily_email_cap}) reached`);
      break;
    }
    case 'email_reply':
      raise(d, 2, 'reply recipients cannot be verified up front');
      break;
  }

  // Everything that does something (tier >= 1) must serve a step of the plan.
  if (d.tier >= 1 && d.tier < 3) {
    const step = ctx.plan?.steps.find((st) => st.id === ctx.stepId) ?? null;
    if (!ctx.plan || !step) raise(d, 2, ctx.stepId ? `step ${ctx.stepId} is not in the plan` : 'call does not reference a plan step');
    else {
      const kinds = row.classifier ? STEP_KINDS_FOR[row.classifier] : undefined;
      if (kinds && !kinds.includes(step.kind)) raise(d, 2, `tool does not match step kind "${step.kind}"`);
      if (d.amountUsd !== null && d.amountUsd > step.max_cost_usd + 0.01)
        raise(d, 2, `amount $${d.amountUsd.toFixed(2)} exceeds step budget $${step.max_cost_usd}`);
    }
  }

  // Tier 1 limit checks. Any failure escalates to owner approval.
  if (d.tier === 1) {
    const moneyMoving = row.classifier === 'transfer' || row.classifier === 'x402';
    if (moneyMoving) {
      if (d.amountUsd === null) raise(d, 2, 'could not price this call');
      else {
        if (d.amountUsd > s.per_action_cap_usd) raise(d, 2, `$${d.amountUsd.toFixed(2)} is over the per-action cap ($${s.per_action_cap_usd})`);
        const spent = spentToday(ctx.mode === 'live' ? 'wallet' : 'wallet_paper');
        if (spent + d.amountUsd > s.daily_spend_cap_usd)
          raise(d, 2, `would exceed the daily spend cap ($${spent.toFixed(2)} + $${d.amountUsd.toFixed(2)} > $${s.daily_spend_cap_usd})`);
      }
    }
    if (!actionTypeSeen(server, tool, ctx.mode)) raise(d, 2, `first ${tool} in ${ctx.mode} mode needs approval once`);
    if (ctx.tainted) raise(d, 2, 'this run already read untrusted content');
  }

  return d;
}
