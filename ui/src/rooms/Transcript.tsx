import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Room, RoomMessage } from '../../../src/shared/comms';
import type { AgentProfile, ApprovalRequest } from '../../../src/shared/types';
import { ApprovalCard } from '../components/ApprovalCard';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Face } from './Stack';
import './rooms.css';
import { activeIn, clearJump, useRooms, type LiveState } from './roomsStore';
import { agentName, cleanGuardText, clock, dayKey, dayLabel, fmtCost, snippet, splitMentions } from './roomsUtil';

const LIVE_TEXT: Record<string, (peer: string) => string> = {
  listening: () => 'received a message and is getting started',
  speaking: () => 'is writing a reply',
  queued: () => 'has a message queued behind its current work',
  'waiting-bot': (peer) => (peer ? `is waiting for ${peer} to answer` : 'is waiting for another bot'),
};

function Mentions({ text, tokens }: { text: string; tokens: string[] }) {
  const parts = useMemo(() => splitMentions(text, tokens), [text, tokens]);
  return <>{parts.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <span key={i} className="rm-mention">{p.mention}</span>))}</>;
}

function Meta({ children }: { children: ReactNode }) { return <span className="rm-meta-i">{children}</span>; }

export function Transcript({ room, messages, agents, approvals, live, loading, error, onRetry }: {
  room: Room; messages: RoomMessage[]; agents: AgentProfile[]; approvals: ApprovalRequest[];
  live: Record<string, LiveState>; loading: boolean; error: string | null; onRetry: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const jump = useRooms((s) => s.jump);
  const nm = useCallback((id: string) => agentName(agents, id), [agents]);
  const mentionTokens = useMemo(() => room.members.flatMap((id) => [id, agents.find((a) => a.id === id)?.name ?? '']).filter(Boolean), [room.members, agents]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const active = activeIn(live, room);
  const hereApprovals = approvals.filter((a) => a.origin?.roomId === room.id);

  const onScroll = useCallback(() => {
    const el = scroller.current; if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    stick.current = near;
    setAway((p) => (p === !near ? p : !near));
  }, []);
  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stick.current = true; setAway(false);
  }, []);

  useLayoutEffect(() => { stick.current = true; toBottom(); }, [room.id, toBottom]);
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messages.length, active.length, hereApprovals.length, loading, toBottom]);

  // Keep following the bottom when the viewport or content resizes (banners, markdown, approval cards, fonts).
  useEffect(() => {
    const el = scroller.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); });
    ro.observe(el); if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [room.id, toBottom]);

  const flash = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1800);
    stick.current = false;
    return true;
  };
  // Open a search hit: scroll to the message once the transcript has loaded.
  useEffect(() => {
    if (!jump || jump.roomId !== room.id || loading) return;
    const t = window.setTimeout(() => { flash(jump.messageId); clearJump(); }, 60);
    return () => window.clearTimeout(t);
  }, [jump, room.id, loading, messages.length]);

  const rows = useMemo(() => {
    const out: ReactNode[] = [];
    let prevDay = '';
    let prev: RoomMessage | undefined;
    for (const m of messages) {
      const dk = dayKey(m.at);
      if (dk !== prevDay) { out.push(<div key={`d-${m.id}`} className="rm-day" role="separator"><span>{dayLabel(m.at)}</span></div>); prevDay = dk; prev = undefined; }
      const cont = !!prev && m.kind === 'chat' && prev.kind === 'chat' && !m.replyTo && m.from.kind === prev.from.kind
        && (m.from.kind !== 'bot' || (prev.from.kind === 'bot' && prev.from.agentId === m.from.agentId))
        && new Date(m.at).getTime() - new Date(prev.at).getTime() < 120_000;
      out.push(<Message key={m.id} m={m} cont={cont} room={room} byId={byId} nm={nm} tokens={mentionTokens} onJump={flash} />);
      prev = m;
    }
    return out;
  }, [messages, room, byId, nm, mentionTokens]);

  return (
    <div className="rm-transcript">
      <div className="rm-scroll thread-scroll scroll-cue" ref={scroller} onScroll={onScroll} role="log" aria-label={`${room.name} transcript`} aria-relevant="additions" tabIndex={0}>
        <div className="rm-inner">
          {error && messages.length === 0 && (
            <div className="rm-state err" role="alert">
              <b>Couldn{'’'}t load this room</b><p>{error}</p>
              <button type="button" className="btn" onClick={onRetry}>Try again</button>
            </div>
          )}
          {loading && messages.length === 0 && <div className="rm-skel-msgs" aria-busy="true" aria-label="Loading messages">{[0, 1, 2].map((i) => <div key={i} className="rm-msg-skel" style={{ width: `${86 - i * 14}%` }} />)}</div>}
          {!loading && !error && messages.length === 0 && (
            <div className="rm-state">
              <b>Nothing said yet</b>
              <p>Write a message below. Bots only wake when they are addressed, so nothing costs money until you speak.</p>
            </div>
          )}
          {messages.length >= 200 && <p className="rm-cap muted-s">Showing the latest 200 messages. Export the room for the full transcript.</p>}
          {rows}
          {hereApprovals.map((a) => <div key={a.id} className="rm-approval"><ApprovalCard a={a} /></div>)}
          {active.length > 0 && (
            <div className="rm-live" aria-live="polite">
              {active.map((a) => (
                <div key={a.agentId} className={`rm-liverow s-${a.state}`}>
                  <Face id={a.agentId} size={24} />
                  <span className="working" aria-hidden="true"><i /><i /><i /></span>
                  <span><b>{nm(a.agentId)}</b> {LIVE_TEXT[a.state]?.(a.peerId ? nm(a.peerId) : '')}</span>
                </div>
              ))}
            </div>
          )}
          <div className="thread-pad" />
        </div>
      </div>
      {away && <button type="button" className="jump" onClick={() => toBottom(true)}><Icon name="down" size={14} /> Latest</button>}
    </div>
  );
}

function ReplyMark({ m, byId, nm, onJump }: { m: RoomMessage; byId: Map<string, RoomMessage>; nm: (id: string) => string; onJump: (id: string) => boolean }) {
  if (!m.replyTo) return null;
  const orig = byId.get(m.replyTo);
  if (!orig) return <span className="rm-reply gone"><Icon name="chevron" size={11} /> reply to an earlier message</span>;
  const who = orig.from.kind === 'human' ? 'You' : orig.from.kind === 'bot' ? nm(orig.from.agentId) : 'System';
  return (
    <button type="button" className="rm-reply" onClick={() => onJump(orig.id)} title="Jump to the message this answers">
      <svg className="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4" /></svg>
      <b>{who}</b><span>{snippet(orig.text, 80)}</span>
    </button>
  );
}

function Message({ m, cont, room, byId, nm, tokens, onJump }: {
  m: RoomMessage; cont: boolean; room: Room; byId: Map<string, RoomMessage>;
  nm: (id: string) => string; tokens: string[]; onJump: (id: string) => boolean;
}) {
  const to = m.to.filter((id) => room.members.includes(id)).map(nm);

  if (m.kind === 'handoff') {
    const from = m.from.kind === 'bot' ? nm(m.from.agentId) : 'A bot';
    const target = m.to[0] ? nm(m.to[0]) : 'another bot';
    return (
      <article className="rm-card handoff" data-mid={m.id} aria-label={`Handoff from ${from} to ${target}`}>
        <div className="rm-card-head">
          <Icon name="chevron" size={14} />
          <b>{from}</b><span className="rm-arrow" aria-hidden="true">{'→'}</span><b>{target}</b>
          <span className="rm-card-tag">handoff</span>
          <span className="spacer" />
          <time dateTime={m.at}>{clock(m.at)}</time>
        </div>
        {m.text && <div className="rm-card-text"><Markdown text={m.text} /></div>}
        <div className="rm-card-foot">{target} now leads this thread.{m.costUsd ? <> {'·'} {fmtCost(m.costUsd)}</> : null}</div>
      </article>
    );
  }

  if (m.kind === 'guard') {
    return (
      <article className="rm-card guard" data-mid={m.id} role="note" aria-label="Guard notice">
        <div className="rm-card-head"><Icon name="shield" size={14} /><b>Guard</b><span className="spacer" /><time dateTime={m.at}>{clock(m.at)}</time></div>
        <div className="rm-card-text">{cleanGuardText(m.text)}</div>
      </article>
    );
  }

  if (m.kind === 'join' || m.kind === 'leave') {
    return <div className="rm-sys join" data-mid={m.id}><span><Icon name={m.kind === 'join' ? 'plus' : 'minus'} size={11} /> {m.text}</span></div>;
  }

  if (m.from.kind === 'system' || m.kind === 'note' || m.kind === 'approval') {
    const bad = /^could not|failed|error|cannot|unable/i.test(m.text);
    return (
      <div className={`rm-sys note${bad ? ' bad' : ''}${m.kind === 'approval' ? ' ap' : ''}`} data-mid={m.id} role={bad ? 'alert' : undefined}>
        <span>
          {m.kind === 'approval' ? <Icon name="shield" size={12} /> : bad ? <Icon name="x" size={12} /> : null}
          {m.text}
          {m.costUsd ? <em> {fmtCost(m.costUsd)}</em> : null}
        </span>
      </div>
    );
  }

  if (m.from.kind === 'human') {
    return (
      <article className={`rm-msg human${cont ? ' cont' : ''}`} data-mid={m.id} aria-label={`You, ${clock(m.at)}`}>
        {!cont && <header className="rm-meta"><time dateTime={m.at}>{clock(m.at)}</time>{to.length > 0 && <Meta>to {to.join(', ')}</Meta>}<b className="who">You</b></header>}
        <div className="rm-bubble"><Mentions text={m.text} tokens={tokens} /></div>
      </article>
    );
  }

  const id = m.from.agentId;
  const maxed = m.hop >= room.guards.maxHops - 1 && room.guards.maxHops > 1;
  return (
    <article className={`rm-msg bot${cont ? ' cont' : ''}`} data-mid={m.id} aria-label={`${nm(id)}, hop ${m.hop}, ${clock(m.at)}`}>
      <div className="rm-av">{!cont && <Face id={id} size={32} />}</div>
      <div className="rm-body">
        {!cont && (
          <header className="rm-meta">
            <b className="who">{nm(id)}</b>
            {room.lead === id && <span className="rm-lead" title="Room lead">lead</span>}
            <span className={`mtag rm-hop${maxed ? ' hot' : ''}`} title={`${m.hop} bot-to-bot hop${m.hop === 1 ? '' : 's'} since your last message`}>hop {m.hop}</span>
            <time dateTime={m.at}>{clock(m.at)}</time>
            {m.costUsd ? <Meta>{fmtCost(m.costUsd)}</Meta> : null}
            {to.length > 0 && <Meta>to {to.join(', ')}</Meta>}
          </header>
        )}
        <ReplyMark m={m} byId={byId} nm={nm} onJump={onJump} />
        <div className="rm-text"><Markdown text={m.text} /></div>
      </div>
    </article>
  );
}
