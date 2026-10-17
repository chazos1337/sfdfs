import type { Tier } from '@mf/shared';

// Static tier map. The tier here is a ceiling-free starting point: argument-
// aware classifiers in policy.ts may only RAISE it for a specific call.
//
// classifier names:
//   transfer      value-moving transfer: caps, allowlist, first-time checks
//   swap          always approval; cross-chain (bridge) is blocked
//   x402          paid API call: host allowlist + quoted price vs caps
//   sign          wallet signature: decoded by intent op
//   portfolio     read; token labels sanitized
//   untrusted_read read whose output is third-party text: taints the run
//   email_read    read of message content: taints the run
//   email_send    outgoing email: recipient allowlist + daily count
//   email_reply   reply: recipient can't be checked up front → approval
//   card          one-time virtual card: approval, merchant must be in plan

export interface ToolMapping {
  tier: Tier;
  classifier: string | null;
  /** true when the name matched exactly; pattern guesses need owner review. */
  exact: boolean;
}

const PAYBOX: Record<string, [Tier, string | null]> = {
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

const AGENTMAIL: Record<string, [Tier, string | null]> = {
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

const PROFILES: Record<string, Record<string, [Tier, string | null]>> = { paybox: PAYBOX, agentmail: AGENTMAIL };

// Pattern fallback for unknown servers or new tools. Order matters: the most
// dangerous patterns are checked first.
const PATTERNS: Array<[RegExp, Tier, string | null]> = [
  [/(secret|seed|mnemonic|private.?key|credential|password|oauth|token|api.?key|export)/i, 3, null],
  [/(filter|forwarding|forward.?rule|auto.?forward|auto.?reply|vacation|delegate|webhook|settings|permission|account.?change)/i, 3, null],
  [/(bridge|allowance|approve_?token|set.?approval)/i, 3, null],
  [/(delete|remove|trash|archive|move|label|update)/i, 2, null],
  [/(swap|trade)/i, 2, 'swap'],
  [/(sign)/i, 2, 'sign'],
  [/(transfer|send_?(funds|payment|token)|pay)/i, 2, null],
  [/(send|reply|forward)/i, 2, null],
  [/(list|get|read|search|fetch|balance|price|quote|status|check)/i, 0, null],
];

export function mapTool(profile: string | undefined, name: string): ToolMapping {
  const exact = profile ? PROFILES[profile]?.[name] : undefined;
  if (exact) return { tier: exact[0], classifier: exact[1], exact: true };
  for (const [re, tier, classifier] of PATTERNS) if (re.test(name)) return { tier, classifier, exact: false };
  return { tier: 3, classifier: null, exact: false };
}
