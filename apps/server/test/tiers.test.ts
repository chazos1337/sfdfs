import { describe, expect, it } from 'vitest';
import { mapTool } from '../src/execution/tiers';
import { AGENTMAIL_TOOLS, PAYBOX_TOOLS } from './helpers';

const PAYBOX_EXPECTED: Record<(typeof PAYBOX_TOOLS)[number], [number, string | null]> = {
  list_credentials: [0, null],
  get_portfolio: [0, 'portfolio'],
  verify_solana_balance: [0, null],
  discover_tokens: [0, 'portfolio'],
  discover_services: [0, 'untrusted_read'],
  discover_plugins: [0, 'untrusted_read'],
  get_contract: [0, 'untrusted_read'],
  get_request: [0, null],
  list_requests: [0, null],
  check_operation_readiness: [0, null],
  reopen_signing_window: [0, null],
  resolve_username: [0, null],
  request_transfer: [1, 'transfer'],
  use_service: [1, 'x402'],
  pay_x402: [1, 'x402'],
  request_swap: [2, 'swap'],
  request_payment: [2, 'card'],
  use_plugin: [2, 'untrusted_read'],
  request_wallet_sign: [2, 'sign'],
  get_buy_link: [2, null],
  get_deposit_link: [2, null],
  claim_payment_credentials: [3, null],
  request_secret: [3, null],
  request_account_change: [3, null],
};

const AGENTMAIL_EXPECTED: Record<(typeof AGENTMAIL_TOOLS)[number], [number, string | null]> = {
  list_inboxes: [0, null],
  get_inbox: [0, null],
  list_threads: [0, 'email_read'],
  get_thread: [0, 'email_read'],
  list_messages: [0, 'email_read'],
  get_message: [0, 'email_read'],
  get_attachment: [0, 'email_read'],
  list_drafts: [0, 'email_read'],
  get_draft: [0, 'email_read'],
  create_draft: [0, null],
  update_draft: [0, null],
  send_message: [1, 'email_send'],
  forward_message: [1, 'email_send'],
  send_draft: [2, null],
  reply_to_message: [2, 'email_reply'],
  reply_all_message: [2, 'email_reply'],
  update_message: [2, null],
  create_inbox: [2, null],
  delete_inbox: [2, null],
  delete_draft: [2, null],
};

describe('static tier map', () => {
  it.each(Object.entries(PAYBOX_EXPECTED))('paybox %s', (tool, [tier, classifier]) => {
    expect(mapTool('paybox', tool)).toEqual({ tier, classifier, exact: true });
  });

  it.each(Object.entries(AGENTMAIL_EXPECTED))('agentmail %s', (tool, [tier, classifier]) => {
    expect(mapTool('agentmail', tool)).toEqual({ tier, classifier, exact: true });
  });

  it('keeps credentials, card numbers and account changes blocked', () => {
    for (const t of ['claim_payment_credentials', 'request_secret', 'request_account_change']) expect(mapTool('paybox', t).tier).toBe(3);
  });

  it('profiles do not leak into each other', () => {
    // send_message is an AgentMail tool; under the PayBox profile it falls back to patterns.
    expect(mapTool('paybox', 'send_message').exact).toBe(false);
    expect(mapTool('agentmail', 'request_transfer').exact).toBe(false);
  });
});

describe('pattern fallback', () => {
  const cases: Array<[string, number, string | null]> = [
    ['export_private_key', 3, null],
    ['get_seed_phrase', 3, null],
    ['reveal_mnemonic', 3, null],
    ['create_oauth_app', 3, null],
    ['create_filter', 3, null],
    ['set_forward_rule', 3, null],
    ['create_forwarding_rule', 3, null],
    ['enable_auto_forward', 3, null],
    ['set_vacation_reply', 3, null],
    ['update_settings', 3, null],
    ['bridge_tokens', 3, null],
    ['approve_token', 3, null],
    ['increase_allowance', 3, null],
    ['delete_thing', 2, null],
    ['archive_thread', 2, null],
    ['swap_exact_in', 2, 'swap'],
    ['sign_message', 2, 'sign'],
    ['transfer_sol', 2, null],
    ['send_payment', 2, null],
    ['send_email', 2, null],
    ['reply_now', 2, null],
    ['get_x', 0, null],
    ['list_things', 0, null],
    ['search_docs', 0, null],
    ['check_status', 0, null],
    ['frobnicate', 3, null],
    ['', 3, null],
  ];

  it.each(cases)('%s -> tier %i', (name, tier, classifier) => {
    for (const profile of [undefined, 'some-other-server']) {
      const m = mapTool(profile, name);
      expect(m.tier).toBe(tier);
      expect(m.classifier).toBe(classifier);
      expect(m.exact).toBe(false);
    }
  });

  it('new tools on a known profile fall back to patterns (and need review)', () => {
    expect(mapTool('paybox', 'get_balance_v2')).toEqual({ tier: 0, classifier: null, exact: false });
    expect(mapTool('paybox', 'export_wallet')).toEqual({ tier: 3, classifier: null, exact: false });
    expect(mapTool('agentmail', 'create_forwarding_rule')).toMatchObject({ tier: 3, exact: false });
  });

  it('dangerous words win over harmless ones in the same name', () => {
    expect(mapTool(undefined, 'get_private_key').tier).toBe(3);
    expect(mapTool(undefined, 'list_api_keys').tier).toBe(3);
    expect(mapTool(undefined, 'get_and_delete').tier).toBe(2);
  });
});
