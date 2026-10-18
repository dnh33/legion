// The one rule for web reads (WebFetch, WebSearch, browser_open). Pure: no I/O.
export const MAX_SEARCH = 300; export const MAX_PATH = 200; export const PATH_BUDGET = 10; export const FRAGMENT_MAX = 16;
const FRAGMENT_SLUG = /^[A-Za-z0-9._~:-]+$/;
export function canonicalHost(raw: string): string | undefined {
  try { const h = new URL(raw).hostname.toLowerCase().replace(/\.+$/, ''); return h || undefined; } catch { return undefined; }
}
export interface WebCall { tool: 'WebFetch' | 'WebSearch' | 'browser_open'; input: Record<string, unknown> }
export interface WebCtx { trusted: (host: string) => boolean; pathsSeen: (host: string) => number; builtIn: (host: string) => boolean; secretRead: boolean }
export type WebVerdict =
  | { kind: 'allow'; host?: string }
  | { kind: 'ask'; host?: string; why: 'new-host' | 'query' | 'userinfo' | 'odd-path' | 'http' | 'port' | 'ip' | 'long-search' | 'budget' | 'secret-read'; canAlways: boolean };

// A host that fetches any other address for you (a reader, an archive, a cache, a translator, a CORS proxy). Approving one
// by name approves the whole web, so such a host always asks, never offers Always allow, and a copy of it in the owner's
// site list does not count as trusted.
// A listed name matches itself and any subdomain of it (wayback.archive.org, i0.wp.com), after a leading "www." is dropped.
// Mirrors and subdomains of a relay are relays too: one Always on a mirror would approve the whole web.
const RELAY_ROOTS: readonly string[] = [
  'treg.to', 'markdown.new', 'jina.ai', 'archive.org', 'archive.ph', 'archive.today', 'archive.is', 'archive.li', 'archive.vn', 'archive.md', 'archive.fo',
  'ghostarchive.org', 'webcache.googleusercontent.com', 'translate.googleusercontent.com', 'translate.google.com', 'translate.goog', '12ft.io',
  'scrape.do', 'api.scraperapi.com', 'corsproxy.io', 'api.allorigins.win', 'cors-anywhere.herokuapp.com', 'proxy.cors.sh',
  'i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com', 'images.weserv.nl', 'wsrv.nl', 'api.codetabs.com', 'thingproxy.freeboard.io', 'api.microlink.io',
];
export const isRelayHost = (host: string): boolean => {
  const h = host.replace(/^www\./, '');
  return RELAY_ROOTS.some((r) => h === r || h.endsWith(`.${r}`));
};

const NEVER_ALWAYS = (h: string): boolean =>
  isRelayHost(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || h === 'localhost' || /\.(localhost|local|internal)$/.test(h) ||
  /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|ow\.ly)$/.test(h) || /\.(github\.io|vercel\.app|pages\.dev|notion\.site|herokuapp\.com|netlify\.app|workers\.dev|web\.app|firebaseapp\.com|appspot\.com|blogspot\.com|gitlab\.io|glitch\.me|repl\.co|onrender\.com|fly\.dev|surge\.sh|ngrok\.io|ngrok-free\.app|trycloudflare\.com|azurewebsites\.net|s3\.amazonaws\.com|cloudfront\.net)$/.test(h);
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

// The first http(s) address inside a URL's path or query, plain or percent-encoded (any case). A tripwire, not a boundary:
// double encoding and redirect forms that carry no http(s) scheme (//host, backslashes, a cross-scheme http:host) are not followed.
const EMBEDDED = /https?(?::|%3a)(?:\/|%2f){2}/i;
export function embeddedUrl(u: URL): string | undefined {
  const rest = u.pathname + u.search;
  const m = EMBEDDED.exec(rest);
  if (!m) return undefined;
  const tail = rest.slice(m.index).split(/[&\s"'<>]/)[0] ?? '';
  try { return decodeURIComponent(tail); } catch { return tail; }
}

const HOST_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
/**
 * Every host a call's address names: its own, the host of an address carried inside it (one level), and, for a relay host,
 * the first path segment that reads as a host (the scheme-less archive form, web.archive.org/web/2020/example.com/x).
 * A host rule matches when any of them is in its list.
 */
export function callHosts(raw: string): string[] {
  let u: URL;
  try { u = new URL(raw); } catch { return []; }
  const out: string[] = [];
  const add = (h: string | undefined): void => { if (h && !out.includes(h)) out.push(h); };
  const own = canonicalHost(raw);
  add(own);
  const inner = embeddedUrl(u);
  if (inner) add(canonicalHost(inner));
  if (own && isRelayHost(own)) {
    for (const seg of u.pathname.split('/')) {
      let d = seg; try { d = decodeURIComponent(seg); } catch { /* keep the raw segment */ }
      if (HOST_SEGMENT.test(d)) { add(canonicalHost(`https://${d}`)); break; }
    }
  }
  return out;
}

/** The stricter of two verdicts: any ask wins, and Always allow is offered only if both sides offer it. */
function stricter(a: WebVerdict, b: WebVerdict): WebVerdict {
  if (a.kind === 'allow') return b;
  if (b.kind === 'allow') return a;
  return { ...a, canAlways: a.canAlways && b.canAlways };
}

/**
 * The verdict for one web call. A WebFetch or browser_open address that carries another address in its path or query is
 * judged twice, once as given and once for the embedded one, and the stricter verdict wins. One level deep only: an
 * address inside the embedded one is not followed.
 */
export function webVerdict(call: WebCall, ctx: WebCtx): WebVerdict {
  const v = judge(call, ctx);
  if (call.tool === 'WebSearch') return v;
  let inner: string | undefined;
  try { inner = embeddedUrl(new URL(typeof call.input.url === 'string' ? call.input.url : '')); } catch { return v; }
  return inner ? stricter(v, judge({ tool: call.tool, input: { url: inner } }, ctx)) : v;
}

function judge(call: WebCall, ctx: WebCtx): WebVerdict {
  if (call.tool === 'WebSearch') {
    const q = typeof call.input.query === 'string' ? call.input.query : '';
    if (ctx.secretRead) return { kind: 'ask', why: 'secret-read', canAlways: false };
    return q.length > MAX_SEARCH ? { kind: 'ask', why: 'long-search', canAlways: false } : { kind: 'allow' };
  }
  const raw = typeof call.input.url === 'string' ? call.input.url : '';
  let u: URL; try { u = new URL(raw); } catch { return { kind: 'ask', why: 'new-host', canAlways: false }; }
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const can = !NEVER_ALWAYS(host);
  const ask = (w: Extract<WebVerdict, { kind: 'ask' }>['why']): WebVerdict => ({ kind: 'ask', host, why: w, canAlways: can });
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'ask', host, why: 'http', canAlways: false };
  // a secret-file read in the run asks every time, with no Always allow
  if (ctx.secretRead) return { kind: 'ask', host, why: 'secret-read', canAlways: false };
  if (u.username || u.password) return ask('userinfo');
  // the URL parser already turns decimal, hex and octal hosts into a dotted quad and wraps IPv6 in brackets
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return ask('ip');
  if (u.protocol !== 'https:') return ask('http');
  if (u.port) return ask('port');
  if (isRelayHost(host) || !ctx.trusted(host)) return ask('new-host');
  // A fragment is never sent in the request, but web_read sends the whole address to its provider and a page's own script can read it:
  // one longer than a short anchor (16 characters) is judged like a query string. A built-in docs host keeps its real anchors, which are
  // long slugs (nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback): there only a fragment that is not a
  // plain slug, or that reads as encoded data, asks.
  const fragment = u.hash.slice(1);
  if (u.search || (fragment.length > FRAGMENT_MAX && (!ctx.builtIn(host) || !FRAGMENT_SLUG.test(fragment) || encodedLooking(fragment)))) return ask('query');
  if (u.pathname.length > MAX_PATH || encodedLooking(u.pathname) || host.split('.').some((l) => l.length > 30 || encodedLooking(l))) return ask('odd-path');
  if (!ctx.builtIn(host) && ctx.pathsSeen(host) > PATH_BUDGET) return ask('budget');
  return { kind: 'allow', host };
}
