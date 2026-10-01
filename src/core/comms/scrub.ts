/**
 * Text hygiene for the comms bridge: secret scrubbing, wrapper-tag neutralising and
 * the normalised hash used by the cycle guard. Pure functions, no I/O.
 */
import { createHash } from 'node:crypto';

const BASE58 = '1-9A-HJ-NP-Za-km-z';

/** Ordered: broad structures first (PEM, URLs), then assignments, then bare token shapes. */
const RULES: Array<{ re: RegExp; to: string | ((...m: string[]) => string); hex?: boolean }> = [
  // PEM private key blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, to: '[redacted-private-key]' },
  // boat.dev (desktop streaming) URLs, any scheme, any subdomain
  { re: /\b(?:https?|wss?):\/\/[^\s"'<>)\]]*\bboat\.dev\b[^\s"'<>)\]]*/gi, to: '[redacted-url]' },
  // boat.dev hosts without a scheme
  { re: /(?<![\w@./-])(?:(?:[a-z0-9-]+\.)+boat\.dev(?:\/[^\s"'<>)\]]*)?|boat\.dev\/[^\s"'<>)\]]+)/gi, to: '[redacted-url]' },
  // any URL that is itself a desktop link or carries a credential in its query string
  { re: /\bhttps?:\/\/[^\s"'<>)\]]*(?:\/desktop\b|[?&](?:token|access_token|key|api_key|apikey|secret|sig|signature|auth)=)[^\s"'<>)\]]*/gi, to: '[redacted-url]' },
  // KEY=value / key: value assignments for secret-looking names (keeps the name)
  {
    re: /(\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)(?!\d+(?![\w]))[^\s"',;]{6,}/gi,
    to: (_m: string, pre: string) => `${pre}[redacted]`,
  },
  // Authorization bearer tokens (must look like a token: digit or token punctuation inside)
  { re: /\bBearer\s+(?=[A-Za-z0-9._~+\/=-]*[0-9._~+\/=-])[A-Za-z0-9._~+\/=-]{8,}/gi, to: 'Bearer [redacted]' },
  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: '[redacted-token]' },
  // sk-... API keys (OpenAI, Anthropic, ...)
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, to: '[redacted-token]' },
  // GitHub, Slack, AWS
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, to: '[redacted-token]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: '[redacted-token]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[redacted-token]' },
  // Bitcoin / BSV WIF private keys: base58, 51 chars starting with 5 or 52 chars starting with K / L
  { re: new RegExp(`\\b(?:5[${BASE58}]{50}|[KL][${BASE58}]{51})\\b`, 'g'), to: '[redacted-key]' },
  // extended BIP32 private keys
  { re: /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{40,}\b/g, to: '[redacted-key]' },
  // 256-bit hex next to a key/secret label (kept even when bare 64-hex is left alone, see `keepHex`)
  {
    re: /(\b(?:priv(?:ate)?[ _-]?key|secret[ _-]?key|signing[ _-]?key|wif)\b[^A-Za-z0-9\n]{0,8}(?:is\s+)?(?:0x)?)[0-9a-fA-F]{64}\b/gi,
    to: (_m: string, pre: string) => `${pre}[redacted-key]`,
  },
  // 256-bit hex private keys / secrets (bare). Skipped with `keepHex`: a 64-hex string is also a transaction id.
  { re: /\b[0-9a-fA-F]{64}\b/g, to: '[redacted-key]', hex: true },
];

export interface ScrubOptions {
  /** Leave bare 64-hex strings alone (BSV/Bitcoin transaction ids). Labelled keys are still redacted. */
  keepHex?: boolean;
  /** Exact secret values (live config tokens) to redact wherever they appear. Values shorter than 8 chars are ignored. */
  exact?: readonly string[];
}

/** Redacts boat desktop URLs and common credential shapes. Idempotent. */
export function scrubSecrets(text: string, opts: ScrubOptions = {}): string {
  let out = text;
  for (const v of opts.exact ?? []) if (typeof v === 'string' && v.length >= 8 && out.includes(v)) out = out.split(v).join('[redacted-secret]');
  for (const r of RULES) {
    if (r.hex && opts.keepHex) continue;
    out = out.replace(r.re, r.to as never);
  }
  return out;
}

const BASE58_RE = `[${BASE58}]`;
const STOPWORDS = new Set('the and for with that this are was you your not but from have has will can all any into which when then them they their what who how why also more some such than'.split(' '));
const SEED_LABEL =
  '(?:seed[ _-]?(?:phrase|words?)|mnemonic(?:[ _-]?(?:phrase|words?))?|recovery[ _-]?(?:phrase|words?)|backup[ _-]?(?:phrase|words?)|secret[ _-]?recovery[ _-]?phrase)';
// label, a little punctuation (or "is"), then 12..24 lowercase words of 3..8 letters. Shape only: no wordlist.
const SEED_RE = new RegExp(`\\b${SEED_LABEL}\\b[\\s:=\\-"'\`(\\[]{0,16}(?:(?:is|are|was)[\\s:="'\`(\\[]{1,5})?((?:[a-z]{3,8}[ \\t,\\n]+){11,23}[a-z]{3,8})\\b`, 'gi');
const PRIVKEY_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{40,}\b/,
  new RegExp(`\\b(?:5${BASE58_RE}{50}|[KL]${BASE58_RE}{51})\\b`),
  /\b(?:priv(?:ate)?[ _-]?key|secret[ _-]?key|signing[ _-]?key|wif)\b[^A-Za-z0-9\n]{0,8}(?:is\s+)?(?:0x)?[0-9a-fA-F]{64}\b/i,
];

/**
 * Text that must never be stored at all (not even redacted): a labelled seed phrase or a private key.
 * Returns what it looked like, or undefined. Bare 64-hex strings (txids) are fine.
 */
export function findForbiddenSecret(text: string): 'seed phrase' | 'private key' | undefined {
  if (PRIVKEY_SHAPES.some((re) => re.test(text))) return 'private key';
  for (const m of text.matchAll(SEED_RE)) {
    const words = m[1]!.toLowerCase().split(/[ \t,\n]+/).filter(Boolean);
    if (words.length >= 12 && words.filter((w) => STOPWORDS.has(w)).length < 4) return 'seed phrase';
  }
  return undefined;
}

const WRAP_TAGS = /<(\/?)(bot-message|human-message|system-note|room-transcript|room-history)\b/gi;

/** Stops text from closing or forging the wrapper tags Legion puts around peer messages. */
export function neutralizeTags(text: string): string {
  return text.replace(WRAP_TAGS, '&lt;$1$2');
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normaliseForCycle(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function cycleHash(text: string): string {
  return createHash('sha1').update(normaliseForCycle(text)).digest('hex');
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

/** Display names go into tag attributes: no quotes, angle brackets or newlines. */
export function safeName(s: string): string {
  return s.replace(/["<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}
