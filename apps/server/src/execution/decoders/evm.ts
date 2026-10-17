// Minimal calldata inspection for wallet signing requests. We only need to
// spot the patterns that hand over control of funds.

const SELECTORS: Record<string, string> = {
  '0x095ea7b3': 'approve',
  '0x39509351': 'increaseAllowance',
  '0xa22cb465': 'setApprovalForAll',
  '0xd505accf': 'permit',
  '0x2b67b570': 'permit2',
};

const HUGE = 2n ** 128n;

export interface Decoded {
  method: string | null;
  dangerous: boolean;
  reason: string | null;
}

export function inspectCalldata(data: unknown): Decoded {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return { method: null, dangerous: false, reason: null };
  const selector = data.slice(0, 10).toLowerCase();
  const method = SELECTORS[selector] ?? null;
  if (!method) return { method: null, dangerous: false, reason: null };
  const args = data.slice(10);
  const word = (i: number) => args.slice(i * 64, (i + 1) * 64);
  if (method === 'approve' || method === 'increaseAllowance') {
    let amount = 0n;
    try {
      amount = BigInt('0x' + (word(1) || '0'));
    } catch {
      return { method, dangerous: true, reason: `${method} with unreadable amount` };
    }
    if (amount >= HUGE) return { method, dangerous: true, reason: `${method} for an unlimited allowance` };
    return { method, dangerous: false, reason: null };
  }
  if (method === 'setApprovalForAll') {
    const on = /[1-9a-f]/i.test(word(1));
    return { method, dangerous: on, reason: on ? 'setApprovalForAll(true) hands over a whole collection' : null };
  }
  return { method, dangerous: true, reason: `${method} signature grants spending rights` };
}

/** EIP-712 typed data that grants allowances (Permit, Permit2, ...). */
export function isPermitTypedData(typed: unknown): boolean {
  const t = typed as { primaryType?: string; domain?: { name?: string } } | null;
  const primary = String(t?.primaryType ?? '');
  const domain = String(t?.domain?.name ?? '');
  return /permit|approval|allowance|delegat/i.test(primary) || /permit2/i.test(domain) || !primary;
}
