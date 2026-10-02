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

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push({ t: 'code', lang: fence[1]!, code: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1]!.length, text: h[2]! }); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      blocks.push({ t: 'ul', items }); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push({ t: 'ol', items }); continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*```/.test(lines[i]!) && !/^(#{1,4})\s+/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) buf.push(lines[i++]!);
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

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\bhttps?:\/\/[^\s<)]+)|(\*[^*\s][^*\n]*\*)/g;

export function tokenizeInline(text: string): Inline[] {
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
