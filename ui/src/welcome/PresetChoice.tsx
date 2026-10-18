// The first-run screen "How should agents ask by default?". Four radio rows, Ask preselected, a live list of what each of the agents really does, and
// an unticked box "Also make my agents follow this". Choosing a looser preset runs the same native confirm as the Gates page (window.legion.gatesChange);
// with the box ticked the default and every agent made looser share ONE native confirm (window.legion.agentModeBatch). Cancelling returns here with Ask selected.
// "Decide later" changes nothing and remembers that the question was seen (firstRunChoice only, no preset), so the screen does not return.
import { useEffect, useRef, useState } from 'react';
import type { Preset } from '../../../src/shared/gates-registry';
import { GatesNote } from '../gates/GatesPresets';
import { disabledReason, presetChoices, type GatesView } from '../gates/presetsLogic';
import { useGatesAction, useGatesView, type GatesNote as Note } from '../gates/useGatesView';
import { PRESET_STRINGS, continueFrom, laterFrom, listWords, shouldShowPresetChoice, type Batch } from './presetChoiceLogic';
import { Icon } from '../components/icons';
import { toast, useStore } from '../store';
import type { AgentProfile } from '../../../src/shared/types';
import '../gates/gates.css';
import './preset-choice.css';

/** The drawn screen. All state comes in as props so a test can render every state. */
export function PresetChoiceView({ view, agents, selected, follow, busy, note, onPick, onFollow, onContinue, onLater }: {
  view: GatesView; agents: readonly AgentProfile[]; selected: Preset; follow: boolean; busy: boolean; note: Note | null;
  onPick: (p: Preset) => void; onFollow: (on: boolean) => void; onContinue: () => void; onLater: () => void;
}) {
  const words = listWords(agents, selected, follow);
  const form = useRef<HTMLFormElement>(null);
  // Enter takes the choice on screen (Ask unless the owner picked another) with nothing focused, or on a radio. No control is focused for the owner: a script-focused
  // radio draws the browser's own ring, and this app draws none. A button or the message box keeps its own Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.defaultPrevented || busy) return;
      const t = e.target as HTMLElement | null;
      const ok = !t || t === document.body || (form.current?.contains(t) === true && t.tagName === 'INPUT');
      if (ok) { e.preventDefault(); onContinue(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <form ref={form} className="firstrun preset-choice" aria-labelledby="preset-choice-h" onSubmit={(e) => { e.preventDefault(); if (!busy) onContinue(); }}>
      <h3 id="preset-choice-h">{PRESET_STRINGS.title}</h3>
      <p className="lead">{PRESET_STRINGS.lead}</p>
      <fieldset className="gates-fs" role="radiogroup" aria-labelledby="preset-choice-h" disabled={busy}>
        {presetChoices().map((c) => {
          const why = disabledReason(view, c.id);
          return (
            <label key={c.id} className={`gates-row gates-choice${why ? ' off' : ''}`}>
              <input type="radio" name="first-run-preset" value={c.id} checked={selected === c.id} disabled={!!why} onChange={() => onPick(c.id)} />
              <span><b>{c.label}</b><span className="field-note">{why ?? c.line}</span></span>
            </label>
          );
        })}
      </fieldset>
      <div className="preset-agents" role="status" aria-live="polite">
        <span>{words.head}</span>
        {words.lines.length > 0 && <ul>{words.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      </div>
      <label className="gates-row gates-choice preset-follow">
        <input type="checkbox" checked={follow} disabled={busy} onChange={(e) => onFollow(e.target.checked)} />
        <span><b>{PRESET_STRINGS.followLabel}</b><span className="field-note">{PRESET_STRINGS.followNote}</span></span>
      </label>
      {words.warn && <p className="gates-warn" role="status"><Icon name="warn" size={13} /> <span>{words.warn}</span></p>}
      {words.info && <p className="field-note" role="status">{words.info}</p>}
      <GatesNote note={note} pending={busy} />
      <div className="preset-choice-actions">
        <button type="submit" className="btn primary" disabled={busy}>{PRESET_STRINGS.continue}</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onLater}>{PRESET_STRINGS.later}</button>
      </div>
      <p className="field-note">{PRESET_STRINGS.laterNote} {PRESET_STRINGS.note}</p>
    </form>
  );
}

/** The screen wired to the core. `onDone` fires after the answer is saved, or when the owner chooses to decide later. */
export function PresetChoice({ onDone }: { onDone: () => void }) {
  const { view, apply } = useGatesView();
  const { pending, note, run } = useGatesAction(apply);
  const agents = useStore((s) => s.agents);
  const [selected, setSelected] = useState<Preset>('ask');
  const [follow, setFollow] = useState(false);
  const [working, setWorking] = useState(false);
  const [own, setOwn] = useState<Note | null>(null);
  if (!view) return null;
  const batch: Batch = window.legion?.agentModeBatch ? (b) => window.legion!.agentModeBatch!(b) as ReturnType<NonNullable<Batch>> : undefined;
  const onContinue = async (): Promise<void> => {
    setWorking(true); setOwn(null);
    try {
      const r = await continueFrom(selected, follow, agents, run, batch);
      if (r.done) {
        // The screen goes away now, so what changed is said where it stays visible.
        if (r.saved) toast(r.saved.text, r.saved.tone === 'error' ? 'error' : 'info');
        onDone();
      } else { setSelected(r.selected); if (r.note) setOwn(r.note); }
    } finally { setWorking(false); }
  };
  // Remembered in the app file like an answer, but with no preset: nothing gets looser, so there is no dialog. If it cannot be written the screen
  // still goes away for this launch and comes back next time.
  const onLater = async (): Promise<void> => { await laterFrom(run); onDone(); };
  return <PresetChoiceView view={view} agents={agents} selected={selected} follow={follow} busy={pending || working} note={own ?? note} onPick={setSelected} onFollow={setFollow} onContinue={() => void onContinue()} onLater={() => void onLater()} />;
}

/**
 * Wraps the welcome. Once the sign-in step is done, a fresh install sees the preset screen first. Closing the app on it shows it again next launch
 * (nothing was written); Decide later is remembered and leaves today's behavior.
 */
export function PresetGate({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const { view } = useGatesView();
  const agents = useStore((s) => s.agents);
  const [done, setDone] = useState(false);
  // Once the screen has opened it stays until the owner is through: saving the answer changes the settings the check reads, and the screen must not
  // vanish in the middle of the second question.
  const opened = useRef(false);
  if (!done && view && shouldShowPresetChoice(view, signedIn, agents)) opened.current = true;
  if (!done && opened.current) return <PresetChoice onDone={() => setDone(true)} />;
  return <>{children}</>;
}
