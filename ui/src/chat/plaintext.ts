/**
 * "Copy as plain text": the reply as the bubble shows it, without Markdown syntax. Built on the renderer's own parser (mdparse.ts), so the
 * two cannot drift apart.
 *  - headings, bold, italic and `code` lose their markers; text stays
 *  - a link [text](url) becomes "text (url)" so the address is not lost; a bare URL stays itself
 *  - lists keep their structure: "- item" and "1. item" (numbered from 1, as drawn)
 *  - code blocks become their plain lines (no fences, no language tag), indentation kept
 *  - a line break inside a paragraph stays a line break; blocks are separated by one blank line
 */
import { parseMarkdown, tokenizeInline } from './mdparse.js';

function plainInline(text: string): string {
  let out = '';
  for (const t of tokenizeInline(text)) {
    if (t.t === 'link') out += t.text === t.href ? t.href : `${t.text} (${t.href})`;
    else out += t.v;
  }
  return out;
}

export function markdownToPlainText(md: string): string {
  const parts: string[] = [];
  for (const b of parseMarkdown(md)) {
    switch (b.t) {
      case 'code': parts.push(b.code); break;
      case 'h': parts.push(plainInline(b.text)); break;
      case 'ul': parts.push(b.items.map((it) => `- ${plainInline(it)}`).join('\n')); break;
      case 'ol': parts.push(b.items.map((it, i) => `${i + 1}. ${plainInline(it)}`).join('\n')); break;
      default: parts.push(b.lines.map(plainInline).join('\n'));
    }
  }
  return parts.join('\n\n').trim();
}
