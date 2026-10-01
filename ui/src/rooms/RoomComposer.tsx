import { useEffect, useMemo, useRef, useState } from 'react';
import type { Room } from '../../../src/shared/comms';
import type { AgentProfile } from '../../../src/shared/types';
import { Icon } from '../components/icons';
import { Face } from './Stack';
import './rooms.css';
import { getDraft, sendMessage, setDraft } from './roomsStore';
import { pauseCopy, whoAnswers } from './roomsUtil';

const MAX_TEXT = 20_000;
interface Cand { key: string; insert: string; label: string; sub: string; agentId?: string }

export function RoomComposer({ room, agents, offline }: { room: Room; agents: AgentProfile[]; offline: boolean }) {
  const [text, setText] = useState(() => getDraft(room.id));
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const nm = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const pause = pauseCopy(room);

  useEffect(() => { setDraft(room.id, text); }, [room.id, text]);
  useEffect(() => { ta.current?.focus(); }, [room.id]);
  const fit = () => { const el = ta.current; if (!el) return; el.style.height = '0px'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; };
  useEffect(fit, [text]);

  // @mention token right before the caret
  const tok = useMemo(() => {
    const m = /(^|[\s(])@([^\s@]*)$/.exec(text.slice(0, caret));
    return m ? { q: m[2] ?? '', start: caret - (m[2]?.length ?? 0) - 1 } : null;
  }, [text, caret]);
  const cands = useMemo<Cand[]>(() => {
    if (!tok) return [];
    const q = tok.q.toLowerCase();
    const all: Cand[] = [];
    if (room.members.length > 1 && room.kind === 'group') all.push({ key: 'everyone', insert: '@everyone', label: '@everyone', sub: 'Wake every member once' });
    for (const id of room.members) {
      const a = agents.find((x) => x.id === id);
      all.push({ key: id, insert: `@${a?.name ?? id}`, label: `@${a?.name ?? id}`, sub: id === room.lead ? 'Lead' : (a?.description ?? ''), agentId: id });
    }
    const score = (c: Cand) => { const l = c.label.slice(1).toLowerCase(); const id = (c.agentId ?? c.key).toLowerCase(); return l.startsWith(q) || id.startsWith(q) ? 0 : l.includes(q) || id.includes(q) ? 1 : 2; };
    return all.filter((c) => score(c) < 2).sort((a, b) => score(a) - score(b));
  }, [tok, room, agents]);
  const menuOpen = !!tok && cands.length > 0 && dismissed !== `${tok.start}:${tok.q}`;
  useEffect(() => { setSel(0); }, [tok?.q, tok?.start]);

  const accept = (c: Cand) => {
    if (!tok) return;
    const before = text.slice(0, tok.start);
    const after = text.slice(caret);
    const next = `${before}${c.insert} ${after.replace(/^ /, '')}`;
    const pos = before.length + c.insert.length + 1;
    setText(next); setCaret(pos);
    requestAnimationFrame(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy || offline) return;
    if (t.length > MAX_TEXT) { setErr(`Messages are limited to ${MAX_TEXT.toLocaleString()} characters.`); return; }
    setBusy(true); setErr('');
    try {
      await sendMessage(room.id, t);
      setText(''); setCaret(0);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
    ta.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => (n + 1) % cands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => (n - 1 + cands.length) % cands.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); accept(cands[Math.min(sel, cands.length - 1)]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(`${tok!.start}:${tok!.q}`); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  const placeholder = offline ? 'Offline. Waiting for Legion core…'
    : pause && !pause.sendResumes ? 'Room is paused. Messages are saved, but no bot wakes until you resume.'
    : room.members.length ? `Message the room. @ to mention ${room.members.slice(0, 2).map(nm).join(', ')}…` : 'Message the room';
  const activeId = menuOpen ? `rm-opt-${Math.min(sel, cands.length - 1)}` : undefined;

  return (
    <div className="composer-wrap rm-composer-wrap">
      <div className={`composer${busy ? ' busy' : ''}`}>
        {menuOpen && (
          <div className="popover rm-mentionmenu" role="listbox" id="rm-mention-list" aria-label="Mention a bot">
            {cands.map((c, i) => (
              <button key={c.key} id={`rm-opt-${i}`} type="button" role="option" aria-selected={i === sel} className={`rm-opt${i === sel ? ' hl' : ''}`}
                onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setSel(i)} onClick={() => accept(c)}>
                {c.agentId ? <Face id={c.agentId} size={22} /> : <span className="rm-opt-all" aria-hidden="true">@</span>}
                <span className="rm-opt-name">{c.label}</span>
                <span className="rm-opt-sub">{c.sub}</span>
              </button>
            ))}
          </div>
        )}
        <textarea ref={ta} rows={1} value={text} placeholder={placeholder} aria-label={`Message ${room.name}`}
          role="combobox" aria-expanded={menuOpen} aria-controls="rm-mention-list" aria-autocomplete="list" aria-activedescendant={activeId} aria-haspopup="listbox"
          disabled={offline}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); setErr(''); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={onKey} />
        <div className="composer-bar">
          <span className="composer-hint rm-who" title={whoAnswers(room, nm)}><span className="rm-who-t">{whoAnswers(room, nm, true)}</span></span>
          <span className="composer-hint"><kbd>Enter</kbd> send <kbd>@</kbd> mention</span>
          <span className="spacer" />
          <button type="button" className="send" disabled={!text.trim() || busy || offline} onClick={() => void send()} aria-label="Send message"><Icon name="send" size={14} /></button>
        </div>
      </div>
      {err && <p className="err-s rm-err" role="alert">{err}</p>}
    </div>
  );
}
