// Detects instruction-shaped text that probably came from a web page or an
// email rather than from our own agents. "freeze" hits stop the crate or plan
// until the owner reviews it; "warn" hits are only recorded.

export interface InjectionHit {
  level: 'freeze' | 'warn';
  pattern: string;
  excerpt: string;
  path: string;
}

const FREEZE: Array<[string, RegExp]> = [
  ['ignore previous instructions', /\b(ignore|disregard|forget)\b[^.\n]{0,20}\b(all |any |the |your )?(previous|prior|above|earlier|system)\b[^.\n]{0,15}\b(instructions?|prompts?|rules|messages?)/i],
  ['send funds to', /\b(send|transfer|wire|move|deposit)\b[^.\n]{0,40}\b(funds|money|crypto|tokens?|coins?|eth|sol|usdc|usdt|btc|balance|payment)\b[^.\n]{0,30}\bto\b[^.\n]{0,10}(0x[0-9a-f]{6,}|address|wallet|this|me|us|[1-9A-HJ-NP-Za-km-z]{32,44})/i],
  ['new instructions', /\b(new|updated|real|actual)\s+(instructions|task|orders)\s*[:\-]/i],
  ['you are now', /\byou are now\b|\bact as (an?|the) (admin|developer|system)\b/i],
  ['system prompt', /\b(system prompt|developer message|jailbreak)\b/i],
  ['reveal secrets', /\b(reveal|share|send|export|paste|enter)\b[^.\n]{0,25}\b(seed phrase|mnemonic|private key|recovery phrase|api key|password)/i],
  ['approve allowance', /\b(approve|grant)\b[^.\n]{0,30}\b(unlimited|max(imum)?|infinite)\b[^.\n]{0,20}\b(allowance|spend|approval)/i],
  ['email exfiltration', /\b(forward|send|email)\b[^.\n]{0,30}\b(all|every|your)\b[^.\n]{0,20}\b(emails?|messages?|inbox|contacts)\b[^.\n]{0,20}\bto\b/i],
];

const WARN: Array<[string, RegExp]> = [
  ['seed phrase mention', /\b(seed phrase|mnemonic|private key)\b/i],
  ['evm address', /\b0x[a-fA-F0-9]{40}\b/],
  ['payment link', /\b(paypal\.me|buy\.stripe\.com|commerce\.coinbase\.com)\/\S+/i],
];

/** Fields whose values are expected to hold URLs/addresses, not prose. */
const QUIET_KEYS = new Set(['url', 'source_id', 'source_ids', 'id']);

function walk(value: unknown, path: string, out: Array<{ path: string; text: string }>) {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (QUIET_KEYS.has(k)) continue;
      walk(v, path ? `${path}.${k}` : k, out);
    }
}

export function scanForInjection(value: unknown): InjectionHit[] {
  const strings: Array<{ path: string; text: string }> = [];
  walk(value, '', strings);
  const hits: InjectionHit[] = [];
  for (const { path, text } of strings) {
    for (const [name, re] of FREEZE) {
      const m = re.exec(text);
      if (m) hits.push({ level: 'freeze', pattern: name, path, excerpt: excerpt(text, m.index, m[0].length) });
    }
    for (const [name, re] of WARN) {
      const m = re.exec(text);
      if (m) hits.push({ level: 'warn', pattern: name, path, excerpt: excerpt(text, m.index, m[0].length) });
    }
  }
  return hits;
}

/**
 * Agents are asked to report suspicious page content in `injection_suspected`.
 * Any such report that is action-shaped also freezes the crate.
 */
export function shouldFreeze(output: { injection_suspected?: Array<{ quote: string; url: string }> } | unknown): {
  freeze: boolean;
  reason: string | null;
  hits: InjectionHit[];
} {
  const hits = scanForInjection(output);
  const freezeHits = hits.filter((h) => h.level === 'freeze');
  if (freezeHits.length) {
    const h = freezeHits[0];
    return { freeze: true, reason: `Instruction-like text (${h.pattern}) at ${h.path}: "${h.excerpt}"`, hits };
  }
  const reported = (output as { injection_suspected?: Array<{ quote: string; url: string }> })?.injection_suspected ?? [];
  if (reported.length) {
    const r = reported[0];
    return { freeze: true, reason: `Agent reported suspected prompt injection from ${r.url}: "${r.quote.slice(0, 160)}"`, hits };
  }
  return { freeze: false, reason: null, hits };
}

function excerpt(text: string, at: number, len: number) {
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + text.slice(start, at + len + 40).replace(/\s+/g, ' ') + (at + len + 40 < text.length ? '…' : '');
}
