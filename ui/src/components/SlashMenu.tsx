import { useEffect, useRef } from 'react';
import type { MenuItem } from '../commands';
import { loadCatalog, useStore } from '../store';

/** Floating command list above the composer. Keyboard handling lives in Composer so focus never leaves the textarea. */
export function SlashMenu({ items, sel, setSel, onPick }: { items: MenuItem[]; sel: number; setSel: (n: number) => void; onPick: (m: MenuItem) => void }) {
  const catalog = useStore((s) => s.catalog);
  const loading = useStore((s) => s.catalogLoading);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('.sm-item.hl')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const legion = items.filter((m) => m.group === 'Legion');
  const cc = items.filter((m) => m.group === 'Claude Code');
  const ccStatus = !catalog
    ? <div className="sm-note"><span className="spin" /> Loading commands{'…'}</div>
    : catalog.error && catalog.commands.length === 0
      ? <div className="sm-note err">Couldn{'’'}t load Claude Code commands <button type="button" className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => void loadCatalog(true)}>{loading ? 'Retrying…' : 'Retry'}</button></div>
      : catalog.commands.length === 0 ? <div className="sm-note">No Claude Code commands found</div> : null;
  const showStatus = ccStatus && cc.length === 0;

  const row = (m: MenuItem) => {
    const n = items.indexOf(m);
    return (
      <button key={m.key} type="button" role="option" aria-selected={n === sel} className={`sm-item${n === sel ? ' hl' : ''}${m.group === 'Legion' ? ' lg' : ''}`}
        onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setSel(n)} onClick={() => onPick(m)}>
        <span className="sm-left"><span className="sm-name">/{m.name}</span>{m.hint && <span className="sm-hint" title={m.hint}>{m.hint}</span>}</span>
        <span className="sm-desc" title={m.description}>{m.costly && <em className="sm-cost">may cost money {'·'} </em>}{m.alias ? <em>alias /{m.alias} {'·'} </em> : null}{m.description}</span>
      </button>
    );
  };

  return (
    <div className="popover slash-menu scroll-cue" role="listbox" aria-label="Commands" ref={list}>
      {legion.length > 0 && <><div className="sm-group">Legion</div>{legion.map(row)}</>}
      {cc.length > 0 && <div className="sm-group">Claude Code <span>{'·'} runs in the agent{'’'}s session</span></div>}
      {cc.map((m, n) => (
        <div key={m.key} style={{ display: 'contents' }}>
          {m.kind === 'skill' && cc[n - 1]?.kind === 'builtin' && <div className="sm-sub">Skills and custom</div>}
          {row(m)}
        </div>
      ))}
      {items.length === 0 && !showStatus && <div className="sm-note">No commands match</div>}
      <div className="sm-bottom">
      {showStatus && <div className="sm-status"><span className="sm-st-label">Claude Code</span>{ccStatus}</div>}
      <div className="sm-foot"><span><kbd>{'↑'}</kbd><kbd>{'↓'}</kbd> move</span><span><kbd>Tab</kbd> insert</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}
