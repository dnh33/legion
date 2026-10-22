// test/guard-scan.ts : the pure scanners behind the source guards (test/source-guards.test.ts). Plain functions on text, so a test can plant a violation and watch them fail.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface Hit { file: string; line: number; text: string }

/** Every file under `dir` (relative to the repo root) whose name matches `ext`, skipping build and vendor folders. */
export function walk(root: string, dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  const go = (d: string): void => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'dist' || n === 'dist-ui' || n === '.git') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) go(p); else if (ext.test(n)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  go(join(root, dir));
  return out;
}

const lineOf = (src: string, idx: number): number => src.slice(0, idx).split('\n').length;
const lineText = (src: string, idx: number): string => (src.split('\n')[lineOf(src, idx) - 1] ?? '').trim();

const COMMENTS = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*`;
/** A catch whose block holds nothing but comments, or a promise catch that does nothing (empty arrow, or only undefined / null). */
const SWALLOW = [
  new RegExp(String.raw`\bcatch\s*(?:\([^)]*\))?\s*\{` + COMMENTS + String.raw`\}`, 'g'),
  new RegExp(String.raw`\.catch\(\s*(?:\([^)]*\)|\w+)?\s*=>\s*(?:\{` + COMMENTS + String.raw`\}|undefined|null|void 0)\s*\)`, 'g'),
];

/** Catches that hide a failure: no statement in the block, or a promise catch that does nothing. */
export function swallowedCatches(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  for (const re of SWALLOW) for (const m of src.matchAll(re)) hits.push({ file, line: lineOf(src, m.index ?? 0), text: lineText(src, m.index ?? 0) });
  return hits.sort((a, b) => a.line - b.line);
}

/** The rule preludes (selectors and at-rules) that enclose each offset of a CSS text, innermost last. */
function preludeAt(src: string, idx: number): string[] {
  const stack: string[] = []; let start = 0;
  for (let i = 0; i < idx; i++) {
    const c = src[i];
    if (c === '{') { stack.push(src.slice(start, i).trim()); start = i + 1; }
    else if (c === '}') { stack.pop(); start = i + 1; }
    else if (c === ';') start = i + 1;
  }
  return stack;
}
/** Comma parts of a selector list, ignoring commas inside brackets or parentheses. */
function selectorParts(sel: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const c of sel) {
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

/**
 * `outline:` with a ring value (anything but none / 0). A ring is allowed only where it is the owner's opt-in setting (every selector of the rule carries
 * `data-focus-rings`) or in the high-contrast block (`forced-colors`). In a .tsx inline style a ring is never allowed.
 */
export function outlineRings(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  const css = /\.css$/.test(file);
  const bare = css ? src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')) : src; // comments blanked, same offsets
  for (const m of src.matchAll(/\boutline(?:-[a-z]+)?\s*:\s*([^;}\n]+)/gi)) {
    const name = m[0].split(':')[0]!.trim().toLowerCase();
    if (name !== 'outline') continue;
    const v = (m[1] ?? '').trim().replace(/^['"]|['",]+$/g, '').replace(/\s*!important$/i, '').trim();
    if (/^(none|0|0px|inherit|unset|initial)$/i.test(v)) continue;
    if (css) {
      const stack = preludeAt(bare, m.index ?? 0);
      if (stack.some((p) => /forced-colors/.test(p))) continue;
      const rule = stack[stack.length - 1] ?? '';
      if (selectorParts(rule).every((p) => p.includes('data-focus-rings'))) continue;
    }
    hits.push({ file, line: lineOf(src, m.index ?? 0), text: lineText(src, m.index ?? 0) });
  }
  return hits;
}

/** A left-edge stripe: border-left wider than 1px, or with a colour token on a card or row. */
export function borderLeftStripes(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of src.matchAll(/\bborder-left(?:-width|-color)?\s*:\s*([^;}\n]+)|\bborderLeft(?:Width|Color)?\s*:\s*([^,}\n]+)/g)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (/^(none|0|0px|transparent|inherit|unset|initial)\b/i.test(v)) continue;
    const w = /(\d+(?:\.\d+)?)px/.exec(v);
    const wide = w !== null && Number(w[1]) > 1;
    const coloured = /var\(--(?![\w-]*(?:line|border|hair|rule|divider|muted|faint))|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(red|green|blue|amber|orange|gold|yellow|purple|accent)\b/i.test(v);
    if (wide || coloured) hits.push({ file, line: lineOf(src, m.index ?? 0), text: lineText(src, m.index ?? 0) });
  }
  return hits;
}

/** An em dash (U+2014) outside a comment. The caller decides which files hold user-facing text. */
export function emDashesOutsideComments(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').map((l) => {
    const m = /(?<!:)\/\//.exec(l); // a line comment (not a URL scheme)
    return m ? l.slice(0, m.index) : l;
  });
  stripped.forEach((l, i) => { if (l.includes('\u2014')) hits.push({ file, line: i + 1, text: (src.split('\n')[i] ?? '').trim() }); });
  return hits;
}

/** Product names of other coding agents, kept encoded so this repo does not spell them. */
const enc = (list: string[]): string[] => list.map((b) => Buffer.from(b, 'base64').toString());
/** Distinctive names (0.3.8: the named integration target is not in the list; it may be named): matched in any letter case, as whole words. */
const DISTINCT = enc(['Q29kZXg=', 'R3Jvaw==', 'V2luZHN1cmY=', 'QWlkZXI=', 'T3BlbkNvZGU=', 'T3BlbkhhbmRz', 'Q3Jld0FJ', 'QXV0b0dQVA==', 'T3BlbkNsYXc=']);
/** Names that are also plain words in code or prose: matched only when written with a capital, as whole words. */
const CAPITAL = enc(['Q3Vyc29y', 'Q2xpbmU=', 'Q29waWxvdA==', 'RGV2aW4=', 'Um9vIENvZGU=', 'S2lsbyBDb2Rl', 'R2VtaW5pIENMSQ==']);
const NAMED = new RegExp(String.raw`\b(?:${DISTINCT.join('|')})\b`, 'i');
const NAMED_CAP = new RegExp(String.raw`\b(?:${CAPITAL.join('|')})\b`);
/** The feature "Soul" + the product word is Legion's own name for the agents' souls; it is not the product. */
const OWN_PHRASE = new RegExp(String.raw`\bsouls?[ -]${DISTINCT[0]}\b`, 'gi');

/** The gate ids no file reads: an id counts as read when a source file (comments cut out) writes it as a quoted string. The registry itself is the caller's to leave out. */
export function unreadGates(ids: readonly string[], sources: ReadonlyArray<{ file: string; text: string }>): string[] {
  const code = sources.map((s) => s.text.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => {
    const m = /(?<!:)\/\//.exec(l);
    return m ? l.slice(0, m.index) : l;
  }).join('\n'));
  return ids.filter((id) => !code.some((t) => ["'", '"', '`'].some((q) => t.includes(`${q}${id}${q}`))));
}

/** Lines that name another coding-agent product. */
export function agentNameHits(file: string, src: string): Hit[] {
  const hits: Hit[] = [];
  src.split('\n').forEach((l, i) => {
    const t = l.replace(OWN_PHRASE, ' ');
    if (NAMED.test(t) || NAMED_CAP.test(t)) hits.push({ file, line: i + 1, text: l.trim() });
  });
  return hits;
}
