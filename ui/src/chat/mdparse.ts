/**
 * The Markdown subset the chat renders, as plain data (no React). Markdown.tsx draws these blocks and tokens; plaintext.ts turns the same
 * ones into "rendered text", so what "Copy as plain text" gives is by construction what the bubble shows, minus the syntax.
 * Supported: paragraphs (a line break stays a line break), # headings, - / * and 1. lists, fenced code, GitHub-style tables, **bold**, *em*,
 * `code`, [text](url), bare URLs.
 */
export type Align = 'left' | 'center' | 'right' | null;
export type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; lang: string; code: string }
  /** `head` and every row have exactly `align.length` cells (short rows padded with '', long rows cut). Cells are raw inline text. */
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

/** A table is drawn only up to this many columns and body rows; a header wider than this is not a table, rows past the cap are plain lines after it. */
export const MAX_TABLE_COLS = 200;
export const MAX_TABLE_ROWS = 5000;

/** Opening fence: ``` then an optional language tag (letters, digits, _, +, -) and nothing else. Linear (no regex backtracking over whitespace). */
function fenceLang(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith('```')) return null;
  const lang = t.slice(3).trim();
  for (let i = 0; i < lang.length; i++) { const c = lang.charCodeAt(i); if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45)) return null; }
  return lang;
}
const isFenceClose = (line: string): boolean => line.trim() === '```';
/**
 * Splits one table line into cells. One leading and one trailing (unescaped) pipe are optional; `\|` is a literal pipe in the cell; a pipe inside
 * an inline `code span` does not split. Linear: every character is visited a bounded number of times (a backtick finds its closing partner with
 * one indexOf and the scan resumes after it; once no backtick is left there is nothing more to pair). Stops after `max` cells.
 */
export function splitRow(line: string, max: number): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  let from = 0; // start of the pending literal run
  let backticks = true;
  while (i < t.length && cells.length < max) {
    const c = t.charCodeAt(i);
    if (c === 92 /* \\ */ && t.charCodeAt(i + 1) === 124 /* | */) { cur += t.slice(from, i) + '|'; i += 2; from = i; continue; }
    if (c === 96 /* ` */ && backticks) {
      const q = t.indexOf('`', i + 1);
      if (q < 0) { backticks = false; i++; continue; }
      // inside the span only `\|` is rewritten (to `|`, as GitHub does); a bare pipe stays part of the code
      let j = i + 1;
      while (j < q) {
        if (t.charCodeAt(j) === 92 && t.charCodeAt(j + 1) === 124 && j + 1 < q) { cur += t.slice(from, j) + '|'; j += 2; from = j; } else j++;
      }
      i = q + 1;
      continue;
    }
    if (c === 124) { cells.push((cur + t.slice(from, i)).trim()); cur = ''; i++; from = i; continue; }
    i++;
  }
  if (cells.length < max) cells.push((cur + t.slice(from)).trim());
  return cells;
}

/** `---`, `:--`, `--:`, `:-:` per cell. Cheap to reject: the first non-space character of a delimiter row is `|`, `:` or `-`. Linear. */
function delimiterRow(line: string): Align[] | null {
  const first = line.trimStart().charCodeAt(0);
  if (!(first === 124 || first === 58 || first === 45) || line.indexOf('|') < 0) return null;
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const out: Align[] = [];
  let i = 0;
  for (;;) {
    let e = t.indexOf('|', i);
    if (e < 0) e = t.length;
    let body = t.slice(i, e).trim();
    const left = body.startsWith(':');
    if (left) body = body.slice(1);
    const right = body.endsWith(':');
    if (right) body = body.slice(0, -1);
    if (!body || !/^-+$/.test(body)) return null;
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    if (out.length > MAX_TABLE_COLS) return null;
    if (e >= t.length) return out;
    i = e + 1;
  }
}

/** Does a table start at `lines[i]`? A header row with a pipe, directly followed by a delimiter row with as many cells. Returns the alignments. */
function tableStart(lines: string[], i: number): { align: Align[]; head: string[] } | null {
  const next = lines[i + 1];
  if (next === undefined || lines[i]!.indexOf('|') < 0) return null;
  const align = delimiterRow(next);
  if (!align) return null;
  const head = splitRow(lines[i]!, MAX_TABLE_COLS + 1);
  if (head.length !== align.length) return null;
  return { align, head };
}
const HEADING = /^(#{1,4})\s+(.*)$/;
const UL = /^\s*[-*]\s+/;
const OL = /^\s*\d+[.)]\s+/;

/**
 * Every line is looked at a bounded number of times and the loop always advances by at least one line, so the cost is linear in the input
 * (an odd fence line such as "```js title=x" is just text; before, it stalled the paragraph loop forever).
 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lang = fenceLang(line);
    if (lang !== null) {
      const buf: string[] = []; i++;
      while (i < lines.length && !isFenceClose(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push({ t: 'code', lang, code: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = HEADING.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1]!.length, text: h[2]! }); i++; continue; }
    const tb = tableStart(lines, i);
    if (tb) {
      const n = tb.align.length;
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && rows.length < MAX_TABLE_ROWS && lines[i]!.trim() && lines[i]!.indexOf('|') >= 0 && fenceLang(lines[i]!) === null) {
        const cells = splitRow(lines[i++]!, n);
        while (cells.length < n) cells.push('');
        rows.push(cells);
      }
      blocks.push({ t: 'table', align: tb.align, head: tb.head, rows });
      continue;
    }
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i]!)) items.push(lines[i++]!.replace(UL, ''));
      blocks.push({ t: 'ul', items }); continue;
    }
    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i]!)) items.push(lines[i++]!.replace(OL, ''));
      blocks.push({ t: 'ol', items }); continue;
    }
    // a paragraph: this line always belongs to it (progress), then the following lines up to a blank line or the start of another block
    const buf: string[] = [lines[i++]!];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.trimStart().startsWith('```') && !HEADING.test(lines[i]!) && !UL.test(lines[i]!) && !OL.test(lines[i]!) && !tableStart(lines, i)) buf.push(lines[i++]!);
    blocks.push({ t: 'p', lines: buf });
  }
  return blocks;
}

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; text: string; href: string };

/**
 * Bounded so no input can make the scan quadratic: link text cannot contain [ or ] (an opener inside restarts at the inner link) and the
 * address is capped at 2048 characters; every other pattern stops at the next marker or the end of the line. Lines over MAX_INLINE are plain.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^[\]\n]{1,500}\]\(https?:\/\/[^)\s]{1,2048}\))|(\bhttps?:\/\/[^\s<)]+)|(\*[^*\s][^*\n]*\*)/g;
export const MAX_INLINE = 20_000;

export function tokenizeInline(text: string): Inline[] {
  if (text.length > MAX_INLINE) return [{ t: 'text', v: text }];
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: 'text', v: text.slice(last, idx) });
    const tok = m[0];
    if (m[1]) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: 'strong', v: tok.slice(2, -2) });
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(tok)!;
      out.push({ t: 'link', text: mm[1]!, href: mm[2]! });
    } else if (m[4]) {
      const url = tok.replace(/[.,;:!?]+$/, '');
      out.push({ t: 'link', text: url, href: url });
      if (url.length < tok.length) out.push({ t: 'text', v: tok.slice(url.length) });
    } else if (m[5]) out.push({ t: 'em', v: tok.slice(1, -1) });
    last = idx + tok.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}
