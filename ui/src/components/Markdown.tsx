import { Fragment, useState, type ReactNode } from 'react';
import { openExternal } from '../api';
import { copyText } from '../util';
import { Icon } from './icons';

/* Markdown-lite: paragraphs, headings, lists, fenced code, **bold**, *em*, `code`, [text](url).
   Everything is emitted as React elements (auto-escaped); no raw HTML. */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\bhttps?:\/\/[^\s<)]+)|(\*[^*\s][^*\n]*\*)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0; let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0]; const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(tok)!;
      out.push(<Link key={k} href={mm[2]}>{mm[1]}</Link>);
    } else if (m[4]) {
      const url = tok.replace(/[.,;:!?]+$/, '');
      out.push(<Link key={k} href={url}>{url}</Link>);
      if (url.length < tok.length) out.push(tok.slice(url.length));
    } else if (m[5]) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="md-link" title={href} rel="noreferrer noopener"
      onClick={(e) => { e.preventDefault(); openExternal(href); }}>{children}</a>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang || 'text'}</span>
        <button className="btn-ghost sm" onClick={async () => { if (await copyText(code)) { setDone(true); window.setTimeout(() => setDone(false), 1400); } }}>
          <Icon name={done ? 'check' : 'copy'} size={12} /> {done ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; lang: string; code: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ t: 'code', lang: fence[1], code: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push({ t: 'ul', items }); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push({ t: 'ol', items }); continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++]);
    blocks.push({ t: 'p', lines: buf });
  }
  return blocks;
}

export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = parse(text);
  return (
    <div className="md">
      {blocks.map((b, bi) => {
        const last = bi === blocks.length - 1;
        const tail = caret && last ? <span className="caret" aria-hidden="true" /> : null;
        switch (b.t) {
          case 'code': return <Fragment key={bi}><CodeBlock lang={b.lang} code={b.code} />{tail}</Fragment>;
          case 'h': return <p key={bi} className={`md-h md-h${b.level}`}>{inline(b.text, `h${bi}`)}{tail}</p>;
          case 'ul':
          case 'ol': {
            const L = b.t;
            return (
              <L key={bi}>
                {b.items.map((it, ii) => <li key={ii}>{inline(it, `l${bi}-${ii}`)}{last && ii === b.items.length - 1 ? tail : null}</li>)}
              </L>
            );
          }
          default:
            return (
              <p key={bi}>
                {b.lines.map((ln, li) => <Fragment key={li}>{li > 0 && <br />}{inline(ln, `p${bi}-${li}`)}</Fragment>)}
                {tail}
              </p>
            );
        }
      })}
      {caret && blocks.length === 0 && <p><span className="caret" aria-hidden="true" /></p>}
    </div>
  );
}
