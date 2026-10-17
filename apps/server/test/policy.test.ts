import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mode, Plan } from '@mf/shared';

// Pricing normally reads the wallet; here every call is priced by the test.
const price = vi.hoisted(() => ({ usd: 1 as number | null }));
vi.mock('../src/execution/pricing', () => ({
  usdValue: vi.fn(async () => price.usd),
  sanitizeLabels: (v: unknown) => v,
}));

import { addAllowlist, addLedger, createAction, updateSettings, upsertTool } from '../src/db/repo';
import { evaluate, type CallContext } from '../src/execution/policy';
import { freshDb, makePlan, PAYBOX_TOOLS, AGENTMAIL_TOOLS, seedTools, step } from './helpers';

const RECIPIENT = 'Friend1111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const plan: Plan = makePlan([
  step('s1', 'transfer', { max_cost_usd: 20 }),
  step('s2', 'swap', { max_cost_usd: 10 }),
  step('s3', 'email_send'),
  step('s4', 'x402_call', { max_cost_usd: 1 }),
  step('s5', 'wallet_read'),
  step('s6', 'card_purchase', { max_cost_usd: 10 }),
]);

function ctx(over: Partial<CallContext> = {}): CallContext {
  return { runId: 1, opportunityId: 1, mode: 'paper', tainted: false, plan, stepId: 's1', ...over };
}

const transferArgs = (over: Record<string, unknown> = {}) => ({ credential_id: 'c', chain: 'solana', to: RECIPIENT, amount: '1000000', token: USDC, ...over });

/** Record that the owner has approved this kind of action once before. */
function seen(server: string, tool: string, mode: Mode = 'paper') {
  createAction({
    opportunity_id: null,
    run_id: null,
    step_id: null,
    server,
    tool,
    input_json: '{}',
    tier: 2,
    tier_reason: 'test',
    mode,
    status: 'approved',
    amount_usd: null,
    recipient: null,
    why: null,
    simulation_json: null,
    output_json: null,
    tx_hash: null,
  });
}

const has = (reasons: string[], re: RegExp) => reasons.some((r) => re.test(r));

beforeEach(() => {
  freshDb();
  price.usd = 1;
  seedTools('paybox', 'paybox', PAYBOX_TOOLS);
  seedTools('agentmail', 'agentmail', AGENTMAIL_TOOLS);
});

describe('tool review gate', () => {
  it('unknown tools are tier 3', async () => {
    const d = await evaluate('paybox', 'nope', {}, ctx());
    expect(d.tier).toBe(3);
    expect(d.reasons).toContain('unknown tool');
  });

  it('unreviewed tools are tier 3 even when their mapped tier is 0', async () => {
    upsertTool({ server: 'paybox', tool: 'get_balance_v2', description: null, input_schema: '{}', schema_hash: 'x', tier: 0, classifier: null });
    const d = await evaluate('paybox', 'get_balance_v2', {}, ctx());
    expect(d.tier).toBe(3);
    expect(has(d.reasons, /not reviewed/)).toBe(true);
  });

  it('a schema change drops a reviewed tool back to tier 3', async () => {
    upsertTool({ server: 'paybox', tool: 'get_portfolio', description: 'changed', input_schema: '{"x":1}', schema_hash: 'different', tier: 0, classifier: 'portfolio' });
    expect((await evaluate('paybox', 'get_portfolio', {}, ctx())).tier).toBe(3);
  });

  it.each(['request_secret', 'claim_payment_credentials', 'request_account_change'])('%s is blocked', async (tool) => {
    const d = await evaluate('paybox', tool, {}, ctx());
    expect(d.tier).toBe(3);
  });

  it('reads are tier 0 and need no plan step', async () => {
    const d = await evaluate('paybox', 'get_portfolio', {}, ctx({ stepId: null }));
    expect(d.tier).toBe(0);
    expect(d.sanitize).toBe(true);
    expect(d.taints).toBe(false);
  });

  it('inbox and plugin reads taint the run', async () => {
    expect((await evaluate('agentmail', 'get_message', {}, ctx({ stepId: null }))).taints).toBe(true);
    expect((await evaluate('agentmail', 'list_threads', {}, ctx({ stepId: null }))).taints).toBe(true);
    expect((await evaluate('paybox', 'discover_services', {}, ctx({ stepId: null }))).taints).toBe(true);
  });
});

describe('transfer', () => {
  it('non-allowlisted recipient → 2', async () => {
    seen('paybox', 'request_transfer');
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /new recipient/)).toBe(true);
    expect(d.recipient).toBe(RECIPIENT);
  });

  it('missing recipient → 2', async () => {
    seen('paybox', 'request_transfer');
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    const d = await evaluate('paybox', 'request_transfer', transferArgs({ to: '' }), ctx());
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /no recipient/)).toBe(true);
  });

  it('allowlisted and under caps, but the first of its kind → 2', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
    expect(d.reasons).toContain('first request_transfer in paper mode needs approval once');
  });

  it('once the owner has approved one → 1', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.reasons).toEqual(['base tier 1']);
    expect(d.tier).toBe(1);
    expect(d.amountUsd).toBe(1);
  });

  it('an approval in paper mode does not count for live mode', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer', 'paper');
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ mode: 'live' }));
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /first request_transfer in live mode/)).toBe(true);
  });

  it('an allowlisted address on another chain is a new recipient', async () => {
    seen('paybox', 'request_transfer');
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'eip155:8453' });
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
  });

  it('EVM addresses match case-insensitively', async () => {
    seen('paybox', 'request_transfer');
    addAllowlist({ kind: 'wallet_address', value: '0xAbCdEf0000000000000000000000000000000001', chain: 'eip155:8453' });
    const d = await evaluate('paybox', 'request_transfer', transferArgs({ chain: 'eip155:8453', to: '0xabcdef0000000000000000000000000000000001' }), ctx());
    expect(d.tier).toBe(1);
  });

  it('over the per-action cap → 2', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    price.usd = 12; // cap defaults to $10; step budget is $20
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /per-action cap/)).toBe(true);
  });

  it('over the daily cap (paper ledger) → 2', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    addLedger('wallet_paper', 48, 'test');
    price.usd = 3;
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /daily spend cap/)).toBe(true);
  });

  it('the live ledger does not count against paper mode', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    addLedger('wallet', 48, 'test');
    price.usd = 3;
    expect((await evaluate('paybox', 'request_transfer', transferArgs(), ctx())).tier).toBe(1);
  });

  it('an unpriceable transfer → 2', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    price.usd = null;
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /could not price/)).toBe(true);
  });

  it('a tainted run → 2', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ tainted: true }));
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /untrusted content/)).toBe(true);
  });

  it('cross-chain transfer → 3', async () => {
    addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
    seen('paybox', 'request_transfer');
    const d = await evaluate('paybox', 'request_transfer', transferArgs({ dst_chain: 'eip155:8453' }), ctx());
    expect(d.tier).toBe(3);
  });

  describe('plan binding', () => {
    beforeEach(() => {
      addAllowlist({ kind: 'wallet_address', value: RECIPIENT, chain: 'solana' });
      seen('paybox', 'request_transfer');
    });

    it('no step id → 2', async () => {
      const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ stepId: null }));
      expect(d.tier).toBe(2);
      expect(d.reasons).toContain('call does not reference a plan step');
    });

    it('a step id that is not in the plan → 2', async () => {
      const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ stepId: 's99' }));
      expect(d.tier).toBe(2);
      expect(d.reasons).toContain('step s99 is not in the plan');
    });

    it('no plan at all → 2', async () => {
      const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ plan: null }));
      expect(d.tier).toBe(2);
    });

    it('wrong step kind → 2', async () => {
      const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx({ stepId: 's5' }));
      expect(d.tier).toBe(2);
      expect(has(d.reasons, /does not match step kind "wallet_read"/)).toBe(true);
    });

    it('amount over the step budget → 2', async () => {
      price.usd = 25; // step s1 allows $20
      const d = await evaluate('paybox', 'request_transfer', transferArgs(), ctx());
      expect(d.tier).toBe(2);
      expect(has(d.reasons, /exceeds step budget/)).toBe(true);
    });
  });
});

describe('swap', () => {
  it('same-chain swap → 2 even after earlier approvals', async () => {
    seen('paybox', 'request_swap');
    const d = await evaluate('paybox', 'request_swap', { src_chain: 'solana', src_token: 'native', dst_token: USDC, amount: '1000' }, ctx({ stepId: 's2' }));
    expect(d.tier).toBe(2);
    expect(d.reasons).toContain('swaps always need approval');
  });

  it('cross-chain swap (bridge) → 3', async () => {
    const d = await evaluate('paybox', 'request_swap', { src_chain: 'solana', dst_chain: 'eip155:8453', src_token: 'native', dst_token: USDC, amount: '1000' }, ctx({ stepId: 's2' }));
    expect(d.tier).toBe(3);
    expect(has(d.reasons, /bridging/)).toBe(true);
  });

  it('a swap against a transfer step → 2 with a kind mismatch', async () => {
    const d = await evaluate('paybox', 'request_swap', { src_chain: 'solana', src_token: 'native', dst_token: USDC, amount: '1000' }, ctx({ stepId: 's1' }));
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /does not match step kind/)).toBe(true);
  });
});

describe('request_wallet_sign', () => {
  const sign = (intent: Record<string, unknown>) => evaluate('paybox', 'request_wallet_sign', { credential_id: 'c', intent }, ctx());
  const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  const spender = pad('0x1111111111111111111111111111111111111111');

  it('raw digest → 3', async () => expect((await sign({ op: 'raw', digest: '0xabc' })).tier).toBe(3));
  it('EIP-7702 authorization → 3', async () => expect((await sign({ op: 'authorization' })).tier).toBe(3));
  it('Permit typed data → 3', async () =>
    expect((await sign({ op: 'typedData', typedData: { primaryType: 'Permit', domain: { name: 'USD Coin' } } })).tier).toBe(3));
  it('Permit2 domain → 3', async () =>
    expect((await sign({ op: 'typedData', typedData: { primaryType: 'PermitSingle', domain: { name: 'Permit2' } } })).tier).toBe(3));
  it('typed data without a primaryType → 3', async () => expect((await sign({ op: 'typedData', typedData: {} })).tier).toBe(3));
  it('ordinary typed data → 2', async () =>
    expect((await sign({ op: 'typedData', typedData: { primaryType: 'Mail', domain: { name: 'Ether Mail' } } })).tier).toBe(2));
  it('message → 2', async () => expect((await sign({ op: 'message', message: 'hello' })).tier).toBe(2));

  it('unlimited approve() calldata → 3', async () => {
    const data = '0x095ea7b3' + spender + 'f'.repeat(64);
    const d = await sign({ op: 'transaction', transaction: { to: '0x2222222222222222222222222222222222222222', data } });
    expect(d.tier).toBe(3);
    expect(has(d.reasons, /unlimited allowance/)).toBe(true);
  });

  it('small approve() calldata → 2', async () => {
    const data = '0x095ea7b3' + spender + pad('0x0f4240');
    expect((await sign({ op: 'transaction', transaction: { to: '0x22', data } })).tier).toBe(2);
  });

  it('increaseAllowance(2^128) → 3', async () => {
    const data = '0x39509351' + spender + pad((2n ** 128n).toString(16));
    expect((await sign({ op: 'transaction', transaction: { data } })).tier).toBe(3);
  });

  it('setApprovalForAll(true) → 3, (false) → 2', async () => {
    expect((await sign({ op: 'transaction', transaction: { data: '0xa22cb465' + spender + pad('1') } })).tier).toBe(3);
    expect((await sign({ op: 'transaction', transaction: { data: '0xa22cb465' + spender + pad('0') } })).tier).toBe(2);
  });

  it('permit() calldata → 3', async () => {
    expect((await sign({ op: 'transaction', transaction: { data: '0xd505accf' + spender } })).tier).toBe(3);
  });

  it('plain transaction → 2', async () => {
    expect((await sign({ op: 'transaction', transaction: { to: '0x22', value: '1' } })).tier).toBe(2);
  });
});

describe('email_send', () => {
  const send = (args: Record<string, unknown>, c: Partial<CallContext> = {}) =>
    evaluate('agentmail', 'send_message', { inboxId: 'factory@agentmail.to', subject: 'Hi', text: 'Hello', ...args }, ctx({ stepId: 's3', ...c }));

  it('non-allowlisted recipient → 2', async () => {
    seen('agentmail', 'send_message');
    const d = await send({ to: 'stranger@example.com' });
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /not allowlisted: stranger@example.com/)).toBe(true);
  });

  it('allowlisted domain passes the recipient check (then first-time applies)', async () => {
    addAllowlist({ kind: 'email_domain', value: 'Partner.com' });
    const d = await send({ to: 'Sam <sam@partner.com>' });
    expect(has(d.reasons, /not allowlisted/)).toBe(false);
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /first send_message/)).toBe(true);
    expect(d.recipient).toBe('sam@partner.com');
  });

  it('allowlisted + seen before → 1', async () => {
    addAllowlist({ kind: 'email_address', value: 'sam@partner.com' });
    seen('agentmail', 'send_message');
    const d = await send({ to: ['sam@partner.com'] });
    expect(d.tier).toBe(1);
  });

  it('a non-allowlisted cc or bcc → 2', async () => {
    addAllowlist({ kind: 'email_domain', value: 'partner.com' });
    seen('agentmail', 'send_message');
    expect((await send({ to: 'sam@partner.com', cc: 'x@evil.example' })).tier).toBe(2);
    expect((await send({ to: 'sam@partner.com', bcc: ['x@evil.example'] })).tier).toBe(2);
    expect((await send({ to: 'sam@partner.com, x@evil.example' })).tier).toBe(2);
  });

  it('a lookalike domain does not match', async () => {
    addAllowlist({ kind: 'email_domain', value: 'partner.com' });
    seen('agentmail', 'send_message');
    expect((await send({ to: 'sam@partner.com.evil.example' })).tier).toBe(2);
    expect((await send({ to: 'sam@evilpartner.com' })).tier).toBe(2);
  });

  it('no recipients → 2', async () => {
    seen('agentmail', 'send_message');
    expect((await send({})).tier).toBe(2);
  });

  it('attachments → 2', async () => {
    addAllowlist({ kind: 'email_domain', value: 'partner.com' });
    seen('agentmail', 'send_message');
    const d = await send({ to: 'sam@partner.com', attachments: [{ filename: 'a.pdf' }] });
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /attachments/)).toBe(true);
  });

  it('daily email cap', async () => {
    addAllowlist({ kind: 'email_domain', value: 'partner.com' });
    seen('agentmail', 'send_message');
    updateSettings({ daily_email_cap: 2 });
    expect((await send({ to: 'sam@partner.com' })).tier).toBe(1);
    for (let i = 0; i < 2; i++)
      createAction({
        opportunity_id: null, run_id: null, step_id: 's3', server: 'agentmail', tool: 'send_message', input_json: '{}', tier: 1, tier_reason: 't',
        mode: 'paper', status: 'simulated', amount_usd: null, recipient: 'sam@partner.com', why: null, simulation_json: null, output_json: null, tx_hash: null,
      });
    const d = await send({ to: 'sam@partner.com' });
    expect(d.tier).toBe(2);
    expect(has(d.reasons, /daily email cap \(2\) reached/)).toBe(true);
  });

  it('forward_message is checked like a send', async () => {
    seen('agentmail', 'forward_message');
    const d = await evaluate('agentmail', 'forward_message', { inboxId: 'i', messageId: 'm', to: 'attacker@evil.example' }, ctx({ stepId: 's3' }));
    expect(d.tier).toBe(2);
  });

  it('replies always need approval', async () => {
    const d = await evaluate('agentmail', 'reply_to_message', { inboxId: 'i', messageId: 'm', text: 'x' }, ctx({ stepId: 's3' }));
    expect(d.tier).toBe(2);
  });
});

describe('x402 and card', () => {
  it('unpaid probe → 0', async () => {
    const d = await evaluate('paybox', 'use_service', { url: 'https://glim.sh/api', mode: 'probe' }, ctx({ stepId: null }));
    expect(d.tier).toBe(0);
  });

  it('allowlisted host, quoted under caps, seen → 1', async () => {
    addAllowlist({ kind: 'x402_host', value: 'glim.sh' });
    seen('paybox', 'use_service');
    const d = await evaluate('paybox', 'use_service', { url: 'https://glim.sh/api' }, ctx({ stepId: 's4' }), { quotedUsd: 0.05 });
    expect(d.tier).toBe(1);
    expect(d.amountUsd).toBe(0.05);
    expect(d.taints).toBe(true);
  });

  it('unknown host → 2', async () => {
    seen('paybox', 'use_service');
    const d = await evaluate('paybox', 'use_service', { url: 'https://evil.example/api' }, ctx({ stepId: 's4' }), { quotedUsd: 0.05 });
    expect(d.tier).toBe(2);
  });

  it('no quote → 2', async () => {
    addAllowlist({ kind: 'x402_host', value: 'glim.sh' });
    seen('paybox', 'use_service');
    const d = await evaluate('paybox', 'use_service', { url: 'https://glim.sh/api' }, ctx({ stepId: 's4' }));
    expect(d.tier).toBe(2);
  });

  it('card purchases → 2', async () => {
    const d = await evaluate('paybox', 'request_payment', { merchant: 'Shop', amount_cents: 500 }, ctx({ stepId: 's6' }));
    expect(d.tier).toBe(2);
    expect(d.amountUsd).toBe(5);
  });
});
