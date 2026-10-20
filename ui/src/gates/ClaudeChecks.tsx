// Settings, Gates: the switch "Claude agents follow Claude's own permission checks" with its one-line meaning and a Learn more panel, the Allow-rules line,
// and the one-time notice shown after the update. The view components take everything as props (a test draws every state); the wired ones read the app.
import { useState } from 'react';
import { Icon } from '../components/icons';
import { announce } from '../projects/page/announce';
import { openSettings, useStore } from '../store';
import { ALLOW_RULES_LINE, checkerFallbackLine, CLAUDE_CHECKS_LABEL, CLAUDE_CHECKS_LINE, CLAUDE_CHECKS_OFF_LINE, CLAUDE_NOTICE, LEARN_LESS, LEARN_MORE, LEARN_MORE_GROUPS, OTHER_PROVIDERS_LINE, type CheckerWho } from '../../../src/shared/claude-checks-copy';
import { GatesNote } from './GatesPresets';
import { KEYSTORE_LINE, type GatesView } from './presetsLogic';
import { claudeChecksOn, checkerFallbackNow, shouldShowClaudeNotice } from './claudeChecksLogic';
import { useGatesAction, useGatesView, type GatesChangeRequest, type GatesNote as Note } from './useGatesView';
import './gates.css';

/** The card under "How agents ask": the switch, what it means, where it does not apply, and the details on request. */
export function ClaudeChecksCardView({ view, busy, note, fallback, onToggle, defaultOpen = false }: {
  view: GatesView; busy: boolean; note: Note | null; /** Who had no Claude checker on their newest run (empty: nobody). */ fallback: readonly CheckerWho[]; onToggle: (on: boolean) => void; defaultOpen?: boolean;
}) {
  const on = claudeChecksOn(view);
  const [open, setOpen] = useState(defaultOpen);
  // Turning it on loosens, so it needs the signing key; turning it off never does.
  const noKey = !on && !view.canSign;
  return (
    <div className="set-card gates-claude" aria-label="Claude agents">
      <label className="gates-row gates-choice gates-claude-switch">
        <input type="checkbox" role="switch" checked={on} disabled={busy || noKey} onChange={(e) => onToggle(e.target.checked)} />
        <span><b>{CLAUDE_CHECKS_LABEL}</b>
          <span className="field-note">{on ? CLAUDE_CHECKS_LINE : CLAUDE_CHECKS_OFF_LINE}</span>
          {noKey && <span className="field-note">{KEYSTORE_LINE}</span>}
        </span>
      </label>
      <p className="gates-text">{OTHER_PROVIDERS_LINE}</p>
      {on && fallback.length > 0 && <p className="gates-warn" role="status"><Icon name="warn" size={13} /> <span>{checkerFallbackLine(fallback)}</span></p>}
      <GatesNote note={note} pending={busy} />
      <button type="button" className="btn-ghost sm gates-learn" aria-expanded={open} aria-controls="gates-claude-help" onClick={() => setOpen((v) => !v)}>{open ? LEARN_LESS : LEARN_MORE}</button>
      {open && (
        <div id="gates-claude-help" className="gates-claude-help">
          {LEARN_MORE_GROUPS.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              <ul>{g.lines.map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** The wired card: the switch goes through the same confirm path as every other setting (the native dialog for the loosening direction). */
export function ClaudeChecksCard({ view, busy, note, run }: { view: GatesView; busy: boolean; note: Note | null; run: (c: GatesChangeRequest, done: string) => Promise<boolean> }) {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const fallback = checkerFallbackNow(tasks, (id) => agents.find((a) => a.id === id)?.name);
  return (
    <ClaudeChecksCardView view={view} busy={busy} note={note} fallback={fallback}
      onToggle={(on) => void run({ kind: 'app', patch: { claudeOwnChecks: on } }, on ? `Claude agents follow Claude's own permission checks.` : `Claude agents follow Legion's own cards again.`)} />
  );
}

/** One line on the Gates rules list: an Allow rule would skip Claude's own checker, so it does not answer Claude's prompts. */
export function AllowRulesNote({ on }: { on: boolean }) {
  return on ? <p className="gates-text" role="note">{ALLOW_RULES_LINE}</p> : null;
}

/** The one-time notice after the update. */
export function ClaudeNoticeView({ busy, note, onOpen, onDismiss }: { busy: boolean; note: Note | null; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="claude-notice" role="status" aria-label="New in Gates">
      <p>{CLAUDE_NOTICE.text}</p>
      <div className="claude-notice-actions">
        <button type="button" className="btn-ghost sm" disabled={busy} onClick={onOpen}>{CLAUDE_NOTICE.open}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={onDismiss}>{CLAUDE_NOTICE.dismiss}</button>
      </div>
      {note?.tone === 'error' && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{note.text}</span></div>}
    </div>
  );
}

/** Shown once, at the top of the window, for an install that was already in use. Either button marks it seen; Open Gates also goes to the page. */
export function ClaudeNotice() {
  const agents = useStore((s) => s.agents);
  const { view, apply } = useGatesView();
  const { pending, note, run } = useGatesAction(apply);
  if (!view || !shouldShowClaudeNotice(view, agents)) return null;
  const seen = () => void run({ kind: 'app', patch: { claudeNoticeSeen: true } }, CLAUDE_NOTICE.dismiss).then((ok) => { if (ok) announce('Done. You will not see this note again.'); });
  return <ClaudeNoticeView busy={pending} note={note} onDismiss={seen} onOpen={() => { openSettings('gates'); seen(); }} />;
}
