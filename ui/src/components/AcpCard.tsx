import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest } from '../../../src/shared/types';
import { cardCountdown, clampOptionName, hostAsks, titleAddsInfo } from '../../../src/shared/acp-copy';
import { decideOption, dismissClosed, type ClosedCard } from '../store';
import { useCardArm, useArmUi } from '../a11y/keyClock';
import { liveReady } from '../a11y/keyClockCore';
import { Icon } from './icons';
import { shortTool } from '../util';

/** Every second while a card has a deadline. The count itself is not announced to a screen reader: only the end is. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * The card for a request Hermes made. The exact command, path or diff is `summary`; the buttons are Hermes's own options, named as Hermes named them.
 * Nothing here is remembered, and an option's kind is read only to tell the core whether the option allows. The card shows the time Hermes still
 * waits and, at the end, that the agent stopped waiting: an answer then would be refused, so no button is left.
 */
export function AcpCard({ a, now }: { a: ApprovalRequest; now?: number }) {
  const tick = useNow(!!a.expiresAt && now === undefined);
  const left = cardCountdown(a.expiresAt, now ?? tick);
  const ended = left?.ended === true;
  const asks = hostAsks(a.acpLabel);
  const arm = useCardArm(`approval:${a.id}`);
  const { armed, refresh } = useArmUi(arm);
  const box = useRef<HTMLDivElement>(null);
  // The answer buttons go away at the end, and a focused button that leaves the page drops focus to the page. Whether focus was on the card is read
  // while rendering (the page still shows the last render, buttons included); at the end the card takes focus itself, and the store then hands it to
  // the closed card's Dismiss.
  const hadFocus = useRef(false);
  if (box.current) hadFocus.current = box.current.contains(document.activeElement);
  useEffect(() => {
    if (ended && hadFocus.current && document.activeElement !== box.current) box.current?.focus();
  }, [ended]);
  // a click before the card is armed does nothing, so it says so: the note while not armed, and the same words once for a screen reader
  const [ignored, setIgnored] = useState(false);
  const [blocks, setBlocks] = useState(0);
  useEffect(() => { if (armed) setIgnored(false); }, [armed]);
  const notReady = (): void => { setIgnored(true); setBlocks((n) => n + 1); refresh(); };
  const answer = (optionId: string, kind: string) => (e: React.MouseEvent) => {
    if (!arm.click(e.detail, performance.now())) { notReady(); return; }
    void decideOption(a.id, kind.startsWith('allow'), optionId);
  };
  return (
    <div ref={box} className="approval acp-card" tabIndex={0} data-approval-id={a.id} data-armed={armed ? 'true' : 'false'} role="group" aria-label={asks}
      onFocus={(e) => { arm.enterFrom(e.currentTarget, e.relatedTarget, performance.now()); refresh(); }}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span>{asks}</span>
        {titleAddsInfo(a.acpTitle, a.summary) && <b className="approval-tool">{a.acpTitle}</b>}
      </div>
      <pre className="approval-sum">{a.summary}</pre>
      <div className="approval-actions">
        {!ended && (a.acpOptions ?? []).map((o) => (
          <button key={o.optionId} type="button" className={o.kind === 'allow_once' ? 'btn primary' : 'btn'} onClick={answer(o.optionId, o.kind)} {...(o.name.length > clampOptionName(o.name).length ? { title: o.name } : {})}>{clampOptionName(o.name)}</button>
        ))}
        {ignored && !armed && !ended && <span className="approval-note">Ready in a moment</span>}
        {!ended && <span className="sr-only" role="status" aria-live="polite">{liveReady(blocks)}</span>}
        {/* the end is announced once, by the closed card that takes this one's place */}
        {left && <span className={`approval-note acp-left${ended ? ' is-ended' : ''}`}>{left.text}</span>}
      </div>
    </div>
  );
}

/**
 * A card that closed with no answer: it stays in the thread so the owner can read what was asked and that nothing was run. It has no answer
 * buttons, only Dismiss. When focus was on the card as it closed, focus moves to Dismiss (never to the page); Dismiss then hands it to the composer.
 */
export function ClosedAcpCard({ c }: { c: ClosedCard }) {
  const a = c.card;
  const dismiss = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (c.focus) dismiss.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hermes = !!a.acpOptions?.length;
  const asks = hostAsks(a.acpLabel);
  return (
    <div className="approval acp-card is-closed" data-approval-id={a.id} role="group" aria-label={`${hermes ? asks : 'Asked for your OK'}, closed`}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span>{hermes ? asks : 'Asked for your OK'}</span>
        {hermes ? (titleAddsInfo(a.acpTitle, a.summary) && <b className="approval-tool">{a.acpTitle}</b>) : <b className="approval-tool">{shortTool(a.toolName)}</b>}
      </div>
      <pre className="approval-sum">{a.summary}</pre>
      <div className="approval-actions">
        <span className="approval-note acp-left is-ended" role="status">{c.late ? `${c.note}. ${c.late}` : c.note}</span>
        <button ref={dismiss} type="button" className="btn sm" onClick={() => dismissClosed(a.id)}>Dismiss</button>
      </div>
    </div>
  );
}
