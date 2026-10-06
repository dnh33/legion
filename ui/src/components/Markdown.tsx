import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { openExternal } from '../api';
import { isSafeHref, parseMarkdown, tokenizeInline, type Block } from '../chat/mdparse';
import { copyText } from '../util';
import { Icon } from './icons';

/* Markdown-lite: paragraphs, headings, lists, fenced code, tables, **bold**, *em*, `code`, [text](url).
   Everything is emitted as React elements (auto-escaped); no raw HTML. */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const t of tokenizeInline(text)) {
    const k = `${key}-${i}`;
    if (t.t === 'text') { out.push(t.v); continue; }
    i++;
    if (t.t === 'code') out.push(<code key={k} className="md-code">{t.v}</code>);
    else if (t.t === 'strong') out.push(<strong key={k}>{t.v}</strong>);
    else if (t.t === 'em') out.push(<em key={k}>{t.v}</em>);
    else out.push(<Link key={k} href={t.href}>{t.text}</Link>);
  }
  return out;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  // Defence in depth: the tokenizer only makes web links, and this refuses anything else a caller might hand in.
  if (!isSafeHref(href)) return <>{children}</>;
  return (
    <a href={href} className="md-link" title={href} rel="noreferrer noopener"
      onClick={(e) => { e.preventDefault(); openExternal(href); }}>{children}</a>
  );
}

function CodeBlock({ lang, code, quiet }: { lang: string; code: string; quiet?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang || (quiet ? '' : 'text')}</span>
        <button className="btn-ghost sm" onClick={async () => { if (await copyText(code)) { setDone(true); window.setTimeout(() => setDone(false), 1400); } }}>
          <Icon name={done ? 'check' : 'copy'} size={12} /> {done ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function Table({ b, bi }: { b: Extract<Block, { t: 'table' }>; bi: number }) {
  const al = (c: number): CSSProperties | undefined => (b.align[c] ? { textAlign: b.align[c]! } : undefined);
  return (
    <div className="md-table-wrap" role="region" aria-label={`Table, ${b.head.length} columns, ${b.rows.length} rows`} tabIndex={0}>
      <table className="md-table">
        <thead><tr>{b.head.map((h, c) => <th key={c} scope="col" style={al(c)}>{inline(h, `th${bi}-${c}`)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((cell, c) => <td key={c} style={al(c)}>{inline(cell, `td${bi}-${ri}-${c}`)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** `quietCode`: a fenced block with no language gets no "text" label (chat keeps it). `headingOffset`: draw headings as real heading elements, shifted down (offset 2 turns `#` into h3). Without it they are styled paragraphs, as in chat. */
export function Markdown({ text, caret, headingOffset, quietCode }: { text: string; caret?: boolean; headingOffset?: number; quietCode?: boolean }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, bi) => {
        const last = bi === blocks.length - 1;
        const tail = caret && last ? <span className="caret" aria-hidden="true" /> : null;
        switch (b.t) {
          case 'code': return <Fragment key={bi}><CodeBlock lang={b.lang} code={b.code} quiet={quietCode} />{tail}</Fragment>;
          case 'table': return <Fragment key={bi}><Table b={b} bi={bi} />{tail}</Fragment>;
          case 'h': {
            if (headingOffset === undefined) return <p key={bi} className={`md-h md-h${b.level}`}>{inline(b.text, `h${bi}`)}{tail}</p>;
            const H = `h${Math.min(6, b.level + headingOffset)}` as 'h3' | 'h4' | 'h5' | 'h6';
            return <H key={bi} className={`md-h md-h${b.level}`}>{inline(b.text, `h${bi}`)}{tail}</H>;
          }
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
