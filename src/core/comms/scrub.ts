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
/** Function words: a run of words with several of these is prose, not a seed phrase (BIP-39 words are almost all content words). */
const FUNCTION_WORDS = new Set((
  'the and for with that this are was were you your not but from have has had will would can could should may might all any into which when then them they their ' +
  'what who how why also more some such than there where while been being does did our out its his her him she his over under before after each every other ' +
  'these those here only very much many most just like once both same own too off'
).split(' '));
const SEED_LABEL =
  '(?:seed(?:[ _-]?(?:phrase|words?))?|mnemonic(?:[ _-]?(?:phrase|words?))?|recovery(?:[ _-]?(?:phrase|words?|seed))?|backup(?:[ _-]?(?:phrase|words?|seed))?' +
  '|bip[ _-]?(?:32|39|44)|(?:12|24|twelve|twenty[ -]?four)[ _-]?words?|words|passphrase|keyphrase|secret[ _-]?recovery[ _-]?phrase)';
const SEED_LABEL_RE = new RegExp(`\\b${SEED_LABEL}\\b`, 'g');
const PRIVKEY_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{40,}\b/,
  new RegExp(`\\b(?:5${BASE58_RE}{50}|[KL]${BASE58_RE}{51})\\b`),
  /\b(?:priv(?:ate)?[ _-]?key|secret[ _-]?key|signing[ _-]?key|wif)\b[^A-Za-z0-9\n]{0,8}(?:is\s+)?(?:0x)?[0-9a-fA-F]{64}\b/i,
];

/**
 * The text as a reader sees it: NFKC (full-width and compatibility forms), zero-width and bidi control characters removed,
 * every kind of space (NBSP, thin space, ideographic space ...) turned into a plain space. Case is kept.
 */
export function normaliseForSecrets(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff]/g, '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ');
}

/** Words (3..8 lowercase letters) that follow a seed label: separators, list numbering and a leading "is" are skipped. At most 31 are read. */
function wordRunAfter(lower: string, from: number): string[] {
  const window = lower.slice(from, from + 700);
  const words: string[] = [];
  let i = 0;
  let first = true;
  const skip = /(?:\s|[:=,;|\/\\.*()\[\]"'`_\u2013\u2014-]|\d{1,2}(?!\d))*/y;
  const word = /[a-z]{3,8}(?![a-z])/y;
  while (words.length < 31) {
    skip.lastIndex = i;
    const s = skip.exec(window);
    const gap = s ? s[0].length : 0;
    if (gap > 64) break;
    i += gap;
    if (first) {
      first = false;
      const filler = /(?:is|are|was)(?![a-z])/y;
      filler.lastIndex = i;
      if (filler.test(window)) { i = filler.lastIndex; continue; }
    }
    word.lastIndex = i;
    const m = word.exec(window);
    if (!m) break;
    words.push(m[0]);
    i = word.lastIndex;
  }
  return words;
}

const proseLike = (words: string[], limit: number): boolean => words.filter((w) => FUNCTION_WORDS.has(w)).length >= limit;

/**
 * Text that must never be stored at all (not even redacted): a labelled seed phrase or a private key. Layout tricks (NBSP,
 * zero-width characters, hyphens or newlines between words, list numbering, a label such as "backup" or "BIP39") are
 * normalised away first. Returns what it looked like, or undefined. Bare 64-hex strings (txids) and a run of words with no
 * label are fine here; see findForbiddenSecretInField for the field-level rule.
 */
export function findForbiddenSecret(text: string): 'seed phrase' | 'private key' | undefined {
  const clean = normaliseForSecrets(text);
  if (PRIVKEY_SHAPES.some((re) => re.test(clean))) return 'private key';
  const lower = clean.toLowerCase();
  for (const m of lower.matchAll(SEED_LABEL_RE)) {
    const words = wordRunAfter(lower, m.index! + m[0].length);
    if (words.length >= 12 && !proseLike(words, 4)) return 'seed phrase';
  }
  return undefined;
}

/** True when the whole field is nothing but 12 to 24 words of 3..8 lowercase letters (spaces, newlines, list numbers between them): the shape of a seed phrase written on its own. */
export function looksLikeSeedList(text: string): boolean {
  const lower = normaliseForSecrets(text).toLowerCase().trim();
  if (lower.length < 36 || lower.length > 400) return false;
  const tokens = lower.split(/\s+/).filter((t) => !/^\d{1,2}[.):]?$/.test(t)).map((t) => t.replace(/^\d{1,2}[.):]+/, ''));
  if (tokens.length < 12 || tokens.length > 24 || tokens.some((t) => !/^[a-z]{3,8}$/.test(t))) return false;
  if (new Set(tokens).size < tokens.length / 2) return false;
  return !proseLike(tokens, 3);
}

/** The rule the knowledge graph applies to every text field of a write: a labelled phrase or key anywhere, or a field that is only a seed-shaped word list. */
export function findForbiddenSecretInField(text: string): 'seed phrase' | 'private key' | undefined {
  return findForbiddenSecret(text) ?? (looksLikeSeedList(text) ? 'seed phrase' : undefined);
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
