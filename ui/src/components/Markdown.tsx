import { Fragment, useState, type ReactNode } from 'react';
import { openExternal } from '../api';
import { parseMarkdown, tokenizeInline } from '../chat/mdparse';
import { copyText } from '../util';
import { Icon } from './icons';

/* Markdown-lite: paragraphs, headings, lists, fenced code, **bold**, *em*, `code`, [text](url).
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

export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = parseMarkdown(text);
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
