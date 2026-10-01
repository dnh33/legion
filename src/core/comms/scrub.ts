/**
 * Text hygiene for the comms bridge: secret scrubbing, wrapper-tag neutralising and
 * the normalised hash used by the cycle guard. Pure functions, no I/O.
 */
import { createHash } from 'node:crypto';
import { BIP39_ENGLISH } from './bip39-words.js';

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

/**
 * Seed phrases. A BIP-39 phrase is 12 to 24 words from one public list of 2048 English words, so the detector counts only
 * those words and ignores everything else around them: labels, numbering, punctuation, bullets and arrows, JSON keys,
 * line breaks, spacing tricks, and function words slipped between the words. The list is the 2048 most common words, so
 * ordinary technical prose is full of them; the rule is therefore strict about the run itself.
 *
 * A text holds a seed phrase when 12 consecutive significant tokens are all list words (at least 10 of them ordinary list
 * words, the rest function words that happen to be on the list, such as "can" or "over"; at least 9 different words), or when
 * 24 consecutive tokens have at most 2 strangers among at least 20 list words. "Significant" means three letters or more
 * and not one of the function words that are not on the list ("the", "and", ...), which may sit between seed words freely.
 * Also tried: the text with rot13 applied, hex and base64 blobs that decode to printable text, letters spaced out one by
 * one, a long unbroken run of letters that splits entirely into list words, and four-letter word prefixes (the first four
 * letters identify every BIP-39 word; they count only when at least four of them occur in the run). Run against this repo's
 * own docs, source and BSV knowledge pack the rule flags only genuine phrases and one block of source code.
 *
 * Limits, stated plainly: only the English list is known (Spanish, Japanese and other lists, Electrum and SLIP-39 phrases
 * are not recognised); a 12-word phrase with one wrong word is not seen; a writer who puts a different junk word between
 * the seed words, or encodes them in some other scheme, gets through; a phrase split across two separate writes is not
 * seen. A labelled run of ordinary non-list words is not a seed phrase and passes. This guards against honest mistakes by
 * a bot, not against a bot that is trying to smuggle a secret out.
 */
const SEED_WORDS: ReadonlySet<string> = new Set(BIP39_ENGLISH);
const SEED_PREFIXES: ReadonlySet<string> = new Set(BIP39_ENGLISH.filter((w) => w.length >= 4).map((w) => w.slice(0, 4)));
const FUNCTION_WORDS = (
  'the and for with that this are was were your not but from have has had will would can could should may might into which when then them they their ' +
  'what who how why more some such than there where while been being does did our out its his her him she over under before after each every other ' +
  'these those here only very much many most just like once both same own too off of to in on at by an or as if is it be so no we he me my up us'
).split(' ');
/** Function words that are not on the list: they sit between seed words without breaking a run. */
const FILLER_WORDS: ReadonlySet<string> = new Set(FUNCTION_WORDS.filter((w) => !SEED_WORDS.has(w)));
/** Function words that are on the list: they count toward a run, but not as evidence (a run needs 10 ordinary list words). */
const SOFT_WORDS: ReadonlySet<string> = new Set(FUNCTION_WORDS.filter((w) => SEED_WORDS.has(w)));
const SEED_RUN = 12;
const SEED_HARD = 10;
const SEED_DISTINCT = 9;
const SEED_LONG = 24;

const SPACED_LETTERS = /(?<!\p{L})\p{L}(?: \p{L}){2,}(?!\p{L})/gu;
const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));

/** True when a string of letters only splits entirely into list words (3..8 letters each) and that takes at least 12 of them. */
function segmentsIntoSeedWords(letters: string): boolean {
  const n = letters.length;
  const best: number[] = new Array(n + 1).fill(-1); // most words that exactly cover the first i letters
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] < 0) continue;
    for (let len = 3; len <= 8 && i + len <= n; len++) {
      if (SEED_WORDS.has(letters.slice(i, i + len))) best[i + len] = Math.max(best[i + len], best[i] + 1);
    }
  }
  return best[n] >= SEED_RUN;
}

const isListToken = (w: string): boolean => SEED_WORDS.has(w) || (w.length === 4 && SEED_PREFIXES.has(w));
/** A stranger that stands alone on its own line or inside parentheses ("(continued)", a heading) is a remark between the words, not part of them. */
const LONE_WORD_LINE = /^[ \t(\[{<*_#>-]*(\p{L}+)[ \t)\]}>*_.:;!?-]*$/gmu;
const PAREN_WORD = /[(\[{]\s*(\p{L}+)\s*[)\]}]/gu;

function hasSeedRun(lowered: string): boolean {
  const text = lowered.replace(SPACED_LETTERS, (m) => m.replace(/ /g, ''))
    .replace(LONE_WORD_LINE, (line, w: string) => (isListToken(w) ? line : ''))
    .replace(PAREN_WORD, (g, w: string) => (isListToken(w) ? g : ' '));
  // per significant token, running totals: strangers, ordinary list words, function words on the list, four-letter prefixes
  const miss: number[] = [0];
  const hard: number[] = [0];
  const pre: number[] = [0];
  const words: string[] = [];
  const add = (a: number[], v: number): void => { a.push(a[a.length - 1]! + v); };
  for (const m of text.matchAll(/\p{L}+/gu)) {
    const t = m[0];
    if (t.length >= 36 && t.length <= 400 && /^[a-z]+$/.test(t) && segmentsIntoSeedWords(t)) return true;
    if (t.length <= 2 || FILLER_WORDS.has(t)) continue;
    const full = SEED_WORDS.has(t);
    const prefix = !full && t.length === 4 && SEED_PREFIXES.has(t);
    add(miss, full || prefix ? 0 : 1);
    add(hard, full && !SOFT_WORDS.has(t) ? 1 : 0);
    add(pre, prefix ? 1 : 0);
    words.push(t);
    const n = words.length;
    const ok = (len: number, maxMiss: number, minHard: number, minDistinct: number): boolean => {
      if (n < len || miss[n]! - miss[n - len]! > maxMiss) return false;
      const p = pre[n]! - pre[n - len]!;
      if (p > 0 && p < 4) return false; // a lone four-letter prefix is just a word
      if (hard[n]! - hard[n - len]! + p < minHard) return false;
      return new Set(words.slice(n - len, n)).size >= minDistinct;
    };
    if (ok(SEED_RUN, 0, SEED_HARD, SEED_DISTINCT) || ok(SEED_LONG, 2, SEED_LONG - 4, SEED_LONG - 6)) return true;
  }
  return false;
}

/** Hex and base64 blobs long enough to hold a phrase, decoded when the result is printable text. */
function decodedBlobs(clean: string): string[] {
  const out: string[] = [];
  const printable = (b: Buffer): boolean => {
    let ok = 0;
    for (const c of b) if ((c >= 0x20 && c < 0x7f) || c === 0x0a) ok++;
    return b.length >= 24 && ok / b.length >= 0.9;
  };
  for (const m of clean.matchAll(/(?<![0-9a-fA-F])(?:[0-9a-fA-F]{2}){24,}(?![0-9a-fA-F])/g)) {
    const b = Buffer.from(m[0], 'hex');
    if (printable(b)) out.push(b.toString('latin1'));
  }
  for (const m of clean.matchAll(/[A-Za-z0-9+/]{36,}={0,2}/g)) {
    const b = Buffer.from(m[0], 'base64');
    if (printable(b)) out.push(b.toString('latin1'));
  }
  return out;
}

/** True when the text carries a BIP-39 seed phrase in any of the layouts above. */
export function containsSeedPhrase(text: string): boolean {
  const clean = normaliseForSecrets(text);
  const lower = clean.toLowerCase();
  if (hasSeedRun(lower) || hasSeedRun(rot13(lower))) return true;
  return decodedBlobs(clean).some((b) => hasSeedRun(b.toLowerCase()));
}

/**
 * Text that must never be stored at all (not even redacted): a seed phrase or a private key. Layout tricks (NBSP,
 * zero-width characters, hyphens or newlines between words, list numbering) are normalised away first. Returns what it
 * looked like, or undefined. Bare 64-hex strings (txids) are fine.
 */
export function findForbiddenSecret(text: string): 'seed phrase' | 'private key' | undefined {
  const clean = normaliseForSecrets(text);
  if (PRIVKEY_SHAPES.some((re) => re.test(clean))) return 'private key';
  return containsSeedPhrase(text) ? 'seed phrase' : undefined;
}

/** The rule the knowledge graph applies to every text field of a write (the same as findForbiddenSecret; kept as its own name for callers). */
export function findForbiddenSecretInField(text: string): 'seed phrase' | 'private key' | undefined {
  return findForbiddenSecret(text);
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
