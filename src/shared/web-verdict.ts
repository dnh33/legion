// The one rule for web reads (WebFetch, WebSearch, browser_open). Pure: no I/O.
import { isIP } from 'node:net';
export const MAX_SEARCH = 300; export const MAX_PATH = 200; export const PATH_BUDGET = 10;
export function canonicalHost(raw: string): string | undefined {
  try { const h = new URL(raw).hostname.toLowerCase().replace(/\.$/, ''); return h || undefined; } catch { return undefined; }
}
export interface WebCall { tool: 'WebFetch' | 'WebSearch' | 'browser_open'; input: Record<string, unknown> }
export interface WebCtx { trusted: (host: string) => boolean; pathsSeen: (host: string) => number; builtIn: (host: string) => boolean; secretValues: readonly string[]; secretRead: boolean }
export type WebVerdict =
  | { kind: 'allow'; host?: string }
  | { kind: 'ask'; host?: string; why: 'new-host' | 'query' | 'userinfo' | 'odd-path' | 'http' | 'port' | 'ip' | 'long-search' | 'budget' | 'secret-read'; canAlways: boolean }
  | { kind: 'refuse'; why: 'secret-value' };

const NEVER_ALWAYS = (h: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h === 'localhost' || /\.(localhost|local|internal)$/.test(h) ||
  /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|ow\.ly)$/.test(h) || /\.(github\.io|vercel\.app|pages\.dev|notion\.site|herokuapp\.com|netlify\.app|workers\.dev|web\.app|firebaseapp\.com|appspot\.com|blogspot\.com|gitlab\.io|glitch\.me|repl\.co|onrender\.com|fly\.dev|surge\.sh|ngrok\.io|ngrok-free\.app|trycloudflare\.com|azurewebsites\.net|s3\.amazonaws\.com|cloudfront\.net)$/.test(h);
// Secret refusal. The haystack is the URL (or query) decoded until stable, lower-cased, plus a copy with every
// non-alphanumeric removed. Each secret (>= 8 chars) is compared in the same normal form, plus its base64, base64url
// and hex forms, plus base64 at the three byte alignments (the stable middle part only).
const decodeStable = (t: string): string => {
  let cur = t;
  for (let i = 0; i < 5; i++) { let next: string; try { next = decodeURIComponent(cur); } catch { break; } if (next === cur) break; cur = next; }
  return cur;
};
const strip = (t: string): string => t.replace(/[^a-z0-9]/g, '');
const needles = (v: string): { plain: string[]; stripped: string[] } => {
  const lv = v.toLowerCase();
  const plain = [lv, Buffer.from(v).toString('base64').toLowerCase(), Buffer.from(v).toString('base64url').toLowerCase(), Buffer.from(v).toString('hex')];
  for (const k of [0, 1, 2]) { const b = Buffer.concat([Buffer.alloc(k, 0x78), Buffer.from(v)]).toString('base64').toLowerCase(); if (b.length - 8 >= 12) plain.push(b.slice(4, -4)); }
  const stripped = plain.map(strip).filter((x) => x.length >= 12);
  if (strip(lv).length >= 12) stripped.push(strip(lv));
  return { plain, stripped };
};
const hasSecret = (t: string, vals: readonly string[]): boolean => {
  const hay = decodeStable(t).toLowerCase(), hayStripped = strip(hay);
  return vals.some((v) => { if (v.length < 8) return false; const n = needles(v); return n.plain.some((x) => hay.includes(x)) || n.stripped.some((x) => hayStripped.includes(x)); });
};
// A path segment or host label that looks like encoded data: long hex, or a long base64/base64url run.
// Base64 mixes cases about evenly (even base64 of plain text, which often has no digits); camelCase names have one
// capital per word and doc slugs are lower case, so neither matches.
// Accepted gaps: lower-case base32 and data split into short segments are not detected here; the per-host path
// budget (PATH_BUDGET) bounds what they can carry on a non-built-in host.
const looksEncoded = (seg: string): boolean => {
  if (/^[0-9a-f]{24,}$/i.test(seg.replace(/[-.]/g, ''))) return true;
  if (!/^[A-Za-z0-9+_-]{24,}={0,2}$/.test(seg)) return false;
  const n = (re: RegExp) => (seg.match(re) ?? []).length;
  const upper = n(/[A-Z]/g), lower = n(/[a-z]/g), letters = upper + lower;
  if (upper >= 2 && lower >= 2 && n(/[0-9]/g) >= 2) return true;
  return letters > 0 && upper / letters >= 0.3 && lower / letters >= 0.3;
};
const encodedLooking = (s: string): boolean => s.split('/').some((seg) => { try { return looksEncoded(decodeURIComponent(seg)); } catch { return looksEncoded(seg); } });

export function webVerdict(call: WebCall, ctx: WebCtx): WebVerdict {
  if (call.tool === 'WebSearch') {
    const q = typeof call.input.query === 'string' ? call.input.query : '';
    if (hasSecret(q, ctx.secretValues)) return { kind: 'refuse', why: 'secret-value' };
    if (ctx.secretRead) return { kind: 'ask', why: 'secret-read', canAlways: false };
    return q.length > MAX_SEARCH ? { kind: 'ask', why: 'long-search', canAlways: false } : { kind: 'allow' };
  }
  const raw = typeof call.input.url === 'string' ? call.input.url : '';
  if (hasSecret(raw, ctx.secretValues)) return { kind: 'refuse', why: 'secret-value' };
  let u: URL; try { u = new URL(raw); } catch { return { kind: 'ask', why: 'new-host', canAlways: false }; }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const can = !NEVER_ALWAYS(host);
  const ask = (w: Extract<WebVerdict, { kind: 'ask' }>['why']): WebVerdict => ({ kind: 'ask', host, why: w, canAlways: can });
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'ask', host, why: 'http', canAlways: false };
  if (ctx.secretRead) return ask('secret-read');
  if (u.username || u.password) return ask('userinfo');
  if (isIP(host.replace(/^\[|\]$/g, ''))) return ask('ip');
  if (u.protocol !== 'https:') return ask('http');
  if (u.port) return ask('port');
  if (!ctx.trusted(host)) return ask('new-host');
  if (u.search) return ask('query');
  if (u.pathname.length > MAX_PATH || encodedLooking(u.pathname) || host.split('.').some((l) => l.length > 30 || encodedLooking(l))) return ask('odd-path');
  if (!ctx.builtIn(host) && ctx.pathsSeen(host) > PATH_BUDGET) return ask('budget');
  return { kind: 'allow', host };
}
