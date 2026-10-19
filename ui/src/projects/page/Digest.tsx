/**
 * "Since you last looked": what needs you, riskiest first, answerable in place. Every number and line comes from the pure models
 * (pageLogic, askLogic); the holds live in answerStore. Spec 3.2.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isArmed } from '../../../../src/shared/approval-keys';
import { appearedAt, pruneAppearances, quietBefore } from '../../a11y/keyClock';
import { digestEvents, digestState } from '../../../../src/shared/attention';
import type { Ask } from '../../../../src/shared/attention';
import { digestKey } from '../hold';
import type { KeyState } from '../hold';
import { loadSpend, markSeen, projectAway, useAway } from '../awayStore';
import { AgentBust } from './AgentBust';
import { announce } from './announce';
import { armAnnouncement, buildAskRows, reconcileShown } from './askLogic';
import { useHoldOff } from './holdOff';
import type { AskRow } from './askLogic';
import { dismissAnswer, holdFocus, holdPointer, resolveOffer, sendNowAnswer, setVisibleRows, startAnswer, undoAnswer, useAnswers } from './answerStore';
import { grantReads } from './readsGrant';
import { findReadsGrant } from './settingsLogic';
import { loadSettings, useStore } from '../../store';
import type { Answer } from './answerStore';
import { digestHeader, foldedLine, hhmm, money, projectTasks, reviewItems, sinceFor, stopDetail } from './pageLogic';
import type { PageFacts } from './pageLogic';
import { getAskRequest, getInboxRequest, requestInbox, subscribeFocus } from '../railRoute';
import { PIcon } from './PIcon';
import { continueTask, openTask, retryTask } from './taskActions';
import { useFocusKeeper } from './useFocusKeeper';

const LINGER_MS = 6000;

export function Digest({ f, asks, agentLens, openBoard }: { f: PageFacts; asks: Ask[]; agentLens: boolean; openBoard: () => void }) {
  const pid = f.project.id;
  const holdOff = useHoldOff(pid);
  const looked = useAway((s) => s.view?.looked[pid]);
  const away = useAway((s) => projectAway(s, pid));
  const quiet = useAway((s) => s.view?.app.quiet);
  const spendUsd = useAway((s) => s.spend[pid]?.sinceUsd ?? 0);
  const answers = useAnswers();
  const sinceMs = useMemo(() => sinceFor(f.project, looked, Date.now()), [f.project, looked]); // eslint-disable-line react-hooks/exhaustive-deps
  const sinceIso = useMemo(() => new Date(sinceMs).toISOString(), [sinceMs]);
  useEffect(() => { void loadSpend(pid, sinceIso); }, [pid, sinceIso]);

  const [expanded, setExpanded] = useState(false);
  const [foot, setFoot] = useState(false);
  const [open, setOpen] = useState(false);          // agent lens: the digest folds to its header until asked
  const [frozen, setFrozen] = useState(false);       // pointer or keyboard focus is inside: nothing moves
  const [armed, setArmed] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  useFocusKeeper(root);

  const rows = useMemo(() => buildAskRows(f, { mode: away.onSilence.mode, parkMinutes: away.onSilence.parkMinutes, ...(quiet ? { quiet } : {}) }), [f, away, quiet]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const events = useMemo(() => digestEvents({ tasks: projectTasks(f), boardInReview: reviewItems(f), sinceMs, spendUsd }), [f, sinceMs, spendUsd]);
  const state = digestState(asks, events, sinceMs);
  const since = hhmm(sinceMs, f.nowMs);

  const prevShown = useRef<string[]>([]);
  const answeredKeys = useMemo(() => new Set(answers.keys()), [answers]);
  // a click that named a row of this digest (an ask, a proposal) keeps that row on screen even past the cap
  const askReq = useSyncExternalStore(subscribeFocus, getAskRequest);
  const inboxReq = useSyncExternalStore(subscribeFocus, getInboxRequest);
  const wantedKey = askReq?.askId || inboxReq?.itemId || '';
  const pin = wantedKey && byKey.has(wantedKey) ? wantedKey : '';
  const { shown, more } = reconcileShown({ prev: prevShown.current, live: rows.map((r) => r.key), answered: answeredKeys, cap: 3, expanded, frozen, ...(pin ? { pin } : {}) });
  prevShown.current = shown;

  // an answered row leaves after a while, but never from under the pointer or the focus
  useEffect(() => {
    if (frozen) return;
    const id = window.setInterval(() => { const now = Date.now(); for (const a of answers.values()) if (a.doneAt && now - a.doneAt > LINGER_MS) dismissAnswer(a.key); }, 1000);
    return () => window.clearInterval(id);
  }, [frozen, answers]);

  // tell the app which rows are on screen: a hold whose row is not (other tab, view, project) is shown by the app-level chip
  const folded = agentLens && !open;
  const shownKey = folded ? '' : shown.join('|');
  useEffect(() => { setVisibleRows(shownKey ? shownKey.split('|') : []); }, [shownKey]);
  useEffect(() => () => setVisibleRows([]), []);

  // keyboard: J/K move between rows; A and D answer under the thread's arming rule (a quiet keyboard, the row on screen long enough)
  const keyState = useRef<KeyState>({});
  // a row's appearance and the page's key clock are the shared ones (keyClock), read the way a card reads them
  for (const k of shown) appearedAt('digest:' + k, performance.now());
  useEffect(() => { pruneAppearances('digest:', new Set(shown.map((k) => 'digest:' + k))); });
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const now = performance.now(), quiet = quietBefore(e.nativeEvent, now, e.key);
    if (e.repeat) return; // a held key is never an answer, and never the second press
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
    const li = t.closest<HTMLElement>('[data-row]');
    if (e.key === 'j' || e.key === 'k') {
      const list = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
      const i = li ? list.indexOf(li) : -1;
      const next = list[e.key === 'j' ? Math.min(list.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
      if (next) { e.preventDefault(); next.focus(); }
      return;
    }
    const key = li?.dataset.row;
    const row = key ? byKey.get(key) : undefined;
    if (!row || answers.has(row.key)) { keyState.current = {}; return; }
    const allow = row.buttons.find((b) => b.act === 'allow');
    const toolName = f.approvals.find((a) => a.id === row.ids[0])?.toolName ?? '';
    const armedNow = isArmed(appearedAt('digest:' + row.key, now), quiet, now);
    const r = digestKey(row.kind === 'command' ? { id: row.key, toolName, level: row.level, certain: row.certain && !!allow } : undefined, e.key, armedNow, Date.now(), keyState.current, e.repeat);
    keyState.current = r.state;
    if (!r.action) { if (armed) setArmed(null); return; }
    e.preventDefault();
    if (r.action.kind === 'arm') {
      setArmed(row.key);
      announce(armAnnouncement(row.hold, holdOff));
      window.setTimeout(() => setArmed((a) => (a === row.key ? null : a)), 2100);
      return;
    }
    setArmed(null);
    const b = row.buttons.find((x) => x.act === (r.action!.kind === 'allow' ? 'allow' : 'deny'));
    if (b) startAnswer({ row, b, projectId: pid, holdOff, height: li?.offsetHeight ?? 0 });
  };

  const act = (row: AskRow, actName: string, b: AskRow['buttons'][number], li: HTMLElement | null): void => {
    if (actName === 'open' || actName === 'review') { if (row.taskId) openTask(row.taskId); else { if (row.kind === 'proposal') requestInbox(pid, row.key); openBoard(); } return; }
    if (actName === 'read') { if (row.kind === 'proposal') requestInbox(pid, row.key); openBoard(); return; }
    const suggested = row.kind === 'proposal' ? f.board?.inbox.find((i) => i.id === row.key)?.proposal?.suggestedAssignee : undefined;
    startAnswer({ row, b, projectId: pid, holdOff, ...(suggested ? { suggestedAssignee: suggested } : {}), height: li?.offsetHeight ?? 0 });
  };

  const head = digestHeader({ needYou: asks.length, hasNew: state.hasNew, since, spendUsd: events.spendUsd });
  const finishedN = events.finished.length + events.inReview.length;
  const footLine = foldedLine(events.failed.length, events.stopped.length, finishedN, since);
  const hasRows = shown.length > 0;
  const toggle = agentLens && (state.hasNew || hasRows)
    ? <button type="button" className="pg-lnk" aria-expanded={!folded} data-fk="dgopen" onClick={() => setOpen((v) => !v)}>{folded ? 'Show asks' : 'Hide asks'}</button> : null;

  return (
    <section ref={root} className="pg-dg" data-region="digest" data-testid="digest" aria-label="Since you last looked" tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setFrozen(true)} onPointerLeave={() => setFrozen(false)}
      onFocusCapture={() => setFrozen(true)} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFrozen(false); }}>
      {head.kind === 'new' ? (
        <div className="pg-dg-h">
          <b>{head.title}</b>
          <span className="sum num"><i>{head.need}</i><span className="pg-sep" aria-hidden="true">/</span>{head.spent}</span>
          <span className="pg-gap" />
          {toggle}
          <button type="button" className="pg-btn ghost sm" data-fk="seen" onClick={() => { void markSeen(pid).then((ok) => { if (ok) announce('Marked as seen. The digest starts from now.'); }); }}>Mark as seen</button>
        </div>
      ) : (
        <div className="pg-dg-quiet" role="status">
          <span className="dot" aria-hidden="true" /><span>{head.text}</span>
          <span className="pg-gap" />{toggle}
        </div>
      )}
      {!folded && hasRows && (
        <>
          <h3 className="pg-dg-sec">{asks.length ? `Needs you (${asks.length}), riskiest first` : 'Answered'}</h3>
          <ul className="pg-ul">
            {shown.map((k) => {
              const a = answers.get(k);
              if (a) return <AnsweredRow key={k} a={a} />;
              const row = byKey.get(k);
              return row ? <OpenRow key={k} row={row} armed={armed === k} onAct={act} /> : null;
            })}
          </ul>
        </>
      )}
      {!folded && more > 0 && <div className="pg-dg-more"><button type="button" className="pg-lnk" aria-expanded={false} data-fk="more" onClick={() => setExpanded(true)}>{more} more {more === 1 ? 'needs' : 'need'} you</button></div>}
      {!folded && expanded && rows.length > 3 && <div className="pg-dg-more"><button type="button" className="pg-lnk" data-fk="more" onClick={() => setExpanded(false)}>Show fewer</button></div>}
      {!folded && footLine && (
        <>
          <div className="pg-dg-foot num"><span><FoldedLine text={footLine} /></span><span className="pg-gap" />
            <button type="button" className="pg-lnk" aria-expanded={foot} data-fk="foot" onClick={() => setFoot((v) => !v)}>{foot ? 'Hide' : 'Show'}</button></div>
          {foot && (
            <div className="pg-dg-list">
              {events.failed.length + events.stopped.length > 0 && <div className="sec">Failed and stopped</div>}
              <ul>
                {[...events.failed, ...events.stopped].map((t) => {
                  const failed = events.failed.includes(t);
                  const who = f.agents.find((x) => x.id === t.agentId)?.name ?? t.agentId;
                  return (
                    <li key={t.id}>
                      <PIcon name={failed ? 'x' : 'pause'} className={`pg-st ${failed ? 'bad' : 'warn'}`} />
                      <span className="t">{who}: {t.title}</span>
                      <span className="m">{failed ? (t.error ?? 'Failed') : stopDetail(t)}</span>
                      <button type="button" className="pg-lnk" data-fk={`f:${t.id}`} aria-label={`Open: ${who} ${t.title}`} onClick={() => openTask(t.id)}>Open</button>
                      <button type="button" className="pg-lnk" data-fk={`g:${t.id}`} aria-label={`${failed ? 'Retry' : 'Continue'}: ${who} ${t.title}`} onClick={() => (failed ? retryTask(t) : void continueTask(t))}>{failed ? 'Retry' : 'Continue'}</button>
                    </li>
                  );
                })}
              </ul>
              {finishedN > 0 && <div className="sec">Finished</div>}
              <ul>
                {[...events.finished].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((t) => {
                  const who = f.agents.find((x) => x.id === t.agentId)?.name ?? t.agentId;
                  return (
                    <li key={t.id}>
                      <PIcon name="ok" className="pg-st" /><span className="t">{who}: {t.title}</span><span className="m">{money(t.costUsd ?? 0)}</span>
                      <button type="button" className="pg-lnk" data-fk={`f:${t.id}`} aria-label={`Open: ${who} ${t.title}`} onClick={() => openTask(t.id)}>Open</button>
                    </li>
                  );
                })}
                {events.inReview.map((i) => (
                  <li key={i.id}>
                    <PIcon name="review" className="pg-st" /><span className="t">{i.title}</span><span className="m">In review</span>
                    <button type="button" className="pg-lnk" data-fk={`r:${i.id}`} aria-label={`Open the board: ${i.title}`} onClick={openBoard}>Open</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function OpenRow({ row, armed, onAct }: { row: AskRow; armed: boolean; onAct: (row: AskRow, act: string, b: AskRow['buttons'][number], li: HTMLElement | null) => void }) {
  return (
    <li className={`pg-row${row.untrusted ? ' untrusted' : ''}`} data-row={row.key} data-fk={row.key} tabIndex={-1}>
      <AgentBust agentId={row.agentId} size={28} />
      <div style={{ minWidth: 0 }}>
        <div className="what"><span className="who">{row.agentName}</span> {row.what}</div>
        <div className="ctx">
          <span className={`pg-conseq${row.quiet ? ' quiet' : ''}`}>{row.chip}</span>
          {row.code && <code title={row.code}>{row.code}</code>}
          {row.ctx && <span>{row.ctx}</span>}
          <span>{row.wait}</span>
        </div>
        {row.trust && <div className="pg-trust">{row.trust}</div>}
        {armed && <div className="pg-hold-note" role="status">This cannot be undone once sent. Press A again to start a {row.hold / 1000} s hold.</div>}
      </div>
      <div className="pg-acts2">
        {row.buttons.map((b) => (
          <span key={`${b.act}:${b.option ?? ''}`} style={{ display: 'contents' }}>
            {b.sepBefore && <span className="div" aria-hidden="true" />}
            <button type="button" className={`pg-btn${b.strong ? ' strong' : ''}`} data-fk={`${row.key}:${b.act}${b.option ? `:${b.option}` : ''}`} aria-label={b.aria}
              onClick={(e) => onAct(row, b.act, b, (e.currentTarget as HTMLElement).closest('li'))}>{b.label}</button>
          </span>
        ))}
      </div>
    </li>
  );
}

export function AnsweredRow({ a }: { a: Answer }) {
  const v = a.view;
  const left = v?.leftMs ?? 0;
  const secs = Math.ceil(left / 1000);
  const holding = a.kind === 'holding';
  return (
    <li className="pg-row done" data-row={a.key} data-fk={a.key} tabIndex={-1} style={{ minHeight: a.height || undefined }}
      onPointerEnter={() => holdPointer(a.key, true)} onPointerLeave={() => holdPointer(a.key, false)}
      onFocus={(e) => holdFocus(a.key, (e.target as HTMLElement).matches(':focus-visible'))}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdFocus(a.key, false); }}>
      <AgentBust agentId={a.row.agentId} size={28} calm />
      <div style={{ minWidth: 0 }}>
        {holding ? (
          <>
            <div className="what">
              <span aria-live="off">{a.row.ing} in <span className="num">{secs}</span> s.</span>{' '}
              <span className="pg-hold-note">{v?.paused ? 'Paused.' : 'Hover or focus pauses the countdown.'}</span>
            </div>
            <div className="pg-holdbar" aria-hidden="true"><i style={{ transform: `scaleX(${v && v.totalMs ? left / v.totalMs : 0})`, transition: 'transform 100ms linear' }} /></div>
          </>
        ) : <div className="what">{a.text}</div>}
        {a.offer === 'pending' && <ReadsOffer a={a} />}
      </div>
      {holding ? (
        <div className="pg-acts2">
          <button type="button" className="pg-btn strong" data-fk={`${a.key}:undo`} aria-label={`Undo: ${a.row.agentName} ${a.row.what}`} onClick={() => { undoAnswer(a.key); const fk = `${a.key}:${a.b.act}${a.b.option ? `:${a.b.option}` : ''}`; requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus()); }}>Undo</button>
          <button type="button" className="pg-btn" data-fk={`${a.key}:sendnow`} aria-label={`Send now: ${a.row.agentName} ${a.row.what}`} onClick={() => sendNowAnswer(a.key)}>Send now</button>
        </div>
      ) : <span />}
    </li>
  );
}

/** "1 failed, 1 stopped, 5 finished or in review since 09:40": the counts in bold, as the mockup has them. */
function FoldedLine({ text }: { text: string }) {
  const i = text.lastIndexOf(' since ');
  const head = i < 0 ? text : text.slice(0, i);
  return (
    <>
      {head.split(', ').map((part, k) => <span key={part}>{k > 0 && ', '}<b>{part}</b></span>)}
      {i < 0 ? null : text.slice(i)}
    </>
  );
}

/** After "Allow all": one project-wide question. Nothing is granted by the first click; Confirm creates the rule, Not now leaves asking as it was. */
function ReadsOffer({ a }: { a: Answer }) {
  const project = useStore((s) => s.projects.find((p) => p.id === a.projectId));
  const settings = useStore((s) => s.settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!settings) void loadSettings(); }, [settings]);
  const granted = !!project && !!findReadsGrant(settings?.gates?.rules ?? [], project);
  useEffect(() => { if (granted || !project) resolveOffer(a.key); }, [granted, project, a.key]);
  if (!project || granted) return null;
  return (
    <div className="pg-offer" role="group" aria-label="Stop asking for reads in this project?" data-testid="reads-offer">
      <b>Stop asking for reads in this project?</b>
      <p>Agents will read files in this project without asking. Writes and commands still ask. You can turn this off in Settings, Safety.</p>
      <div className="row">
        <button type="button" className="pg-btn sm strong" disabled={busy} data-fk={`${a.key}:grant`} onClick={() => { setBusy(true); void grantReads(project).then((ok) => { setBusy(false); if (ok) { announce('Done. Agents read files in this project without asking.'); resolveOffer(a.key); } }); }}>Confirm</button>
        <button type="button" className="pg-btn sm ghost" onClick={() => resolveOffer(a.key)}>Not now</button>
      </div>
    </div>
  );
}
