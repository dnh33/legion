// The first-run screen "How should your agents ask?" (Task 13). One question, four radio rows, Ask preselected.
// Choosing a looser preset runs the same native confirm as the Gates page (window.legion.gatesChange); cancelling returns here with Ask selected.
// "Decide later" leaves today's behavior and remembers that the question was seen (firstRunChoice only, no preset), so the screen does not return.
import { useEffect, useRef, useState } from 'react';
import type { Preset } from '../../../src/shared/gates-registry';
import { GatesNote } from '../gates/GatesPresets';
import { disabledReason, presetChoices, type GatesView } from '../gates/presetsLogic';
import { useGatesAction, useGatesView, type GatesNote as Note } from '../gates/useGatesView';
import { PRESET_STRINGS, continueFrom, laterFrom, shouldShowPresetChoice } from './presetChoiceLogic';
import '../gates/gates.css';
import './preset-choice.css';

/** The drawn screen. All state comes in as props so a test can render every state. */
export function PresetChoiceView({ view, selected, busy, note, onPick, onContinue, onLater }: {
  view: GatesView; selected: Preset; busy: boolean; note: Note | null;
  onPick: (p: Preset) => void; onContinue: () => void; onLater: () => void;
}) {
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
      <GatesNote note={note} pending={busy} />
      <div className="preset-choice-actions">
        <button type="submit" className="btn primary" disabled={busy}>{PRESET_STRINGS.continue}</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={onLater}>{PRESET_STRINGS.later}</button>
      </div>
      <p className="field-note">{PRESET_STRINGS.note}</p>
      <p className="field-note">{PRESET_STRINGS.laterNote}</p>
    </form>
  );
}

/** The screen wired to the core. `onDone` fires after the answer is saved, or when the owner chooses to decide later. */
export function PresetChoice({ onDone }: { onDone: () => void }) {
  const { view, apply } = useGatesView();
  const { pending, note, run } = useGatesAction(apply);
  const [selected, setSelected] = useState<Preset>('ask');
  if (!view) return null;
  const onContinue = async (): Promise<void> => {
    const r = await continueFrom(selected, run);
    if (r.done) onDone();
    else setSelected(r.selected);
  };
  // Remembered in the app file like an answer, but with no preset: nothing gets looser, so there is no dialog. If it cannot be written the screen
  // still goes away for this launch and comes back next time.
  const onLater = async (): Promise<void> => { await laterFrom(run); onDone(); };
  return <PresetChoiceView view={view} selected={selected} busy={pending} note={note} onPick={setSelected} onContinue={() => void onContinue()} onLater={() => void onLater()} />;
}

/**
 * Wraps the welcome. Once the sign-in step is done, a fresh install sees the preset screen first. Closing the app on it shows it again next launch
 * (nothing was written); Decide later is remembered and leaves today's behavior.
 */
export function PresetGate({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  const { view } = useGatesView();
  const [later, setLater] = useState(false);
  if (!later && view && shouldShowPresetChoice(view, signedIn)) return <PresetChoice onDone={() => setLater(true)} />;
  return <>{children}</>;
}
