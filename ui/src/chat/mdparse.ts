/**
 * The Markdown subset the chat renders, as plain data (no React). Markdown.tsx draws these blocks and tokens; plaintext.ts turns the same
 * ones into "rendered text", so what "Copy as plain text" gives is by construction what the bubble shows, minus the syntax.
 * Supported: paragraphs (a line break stays a line break), # headings, - / * and 1. lists, fenced code, **bold**, *em*, `code`, [text](url), bare URLs.
 */
export type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; lang: string; code: string };

/** Opening fence: ``` then an optional language tag (letters, digits, _, +, -) and nothing else. Linear (no regex backtracking over whitespace). */
function fenceLang(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith('```')) return null;
  const lang = t.slice(3).trim();
  for (let i = 0; i < lang.length; i++) { const c = lang.charCodeAt(i); if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45)) return null; }
  return lang;
}
const isFenceClose = (line: string): boolean => line.trim() === '```';
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
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.trimStart().startsWith('```') && !HEADING.test(lines[i]!) && !UL.test(lines[i]!) && !OL.test(lines[i]!)) buf.push(lines[i++]!);
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
