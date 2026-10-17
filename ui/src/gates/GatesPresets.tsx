import { useState } from 'react';
import type { AgentProfile } from '../../../src/shared/types';
import type { Project } from '../../../src/shared/projects';
import type { Preset } from '../../../src/shared/gates-registry';
import { Icon } from '../components/icons';
import { PAGE_NOTES, agentsFollowLine, disabledReason, presetChoices, scopeSummary, KEYSTORE_LINE, type GatesView } from './presetsLogic';
import { PENDING_TEXT, reloadGatesFromDisk, type GatesChangeRequest, type GatesNote as Note } from './useGatesView';

export const EVERYTHING = 'app';

/** What a scope is called in a sentence. */
export const scopeLabel = (scope: string, projects: readonly Project[]): string => (scope === EVERYTHING ? 'all projects' : `the project ${projects.find((p) => p.id === scope)?.name ?? scope}`);

/** A line under a block: the visible result of the last change, or why it failed. */
export function GatesNote({ note, pending }: { note: Note | null; pending: boolean }) {
  if (pending) return <p className="gates-note" role="status">{PENDING_TEXT}</p>;
  if (!note) return null;
  if (note.tone === 'error') return <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{note.text}</span></div>;
  return <p className={`gates-note ${note.tone}`} role="status">{note.text}</p>;
}

/** The banner for settings files that changed outside Legion or could not be read. Legion keeps using Ask for them until the owner decides. */
export function GatesBanner({ view, projects, busy, run, onReloaded }: {
  view: GatesView; projects: readonly Project[]; busy: boolean;
  run: (c: GatesChangeRequest, done: string) => Promise<boolean>; onReloaded: () => void | Promise<void>;
}) {
  // Reload is not a settings change (no confirmation), so it keeps its own result: the core can refuse it, and a file can stay unreadable.
  const [reloading, setReloading] = useState(false);
  const [reload, setReload] = useState<Note | null>(null);
  if (view.changedOutside.length === 0 && view.unreadable.length === 0) return null;
  const nameOf = (n: string) => scopeLabel(n, projects);
  const list = (names: string[]) => names.map(nameOf).join(' and ');
  const doReload = async () => {
    setReloading(true); setReload(null);
    try { await reloadGatesFromDisk(); await onReloaded(); setReload({ tone: 'info', text: 'Read the files again.' }); }
    catch (e) { setReload({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); }
    setReloading(false);
  };
  return (
    <div className="gates-banner" role="alert">
      <Icon name="warn" size={15} />
      <div className="gates-banner-body">
        {view.changedOutside.length > 0 && (
          <>
            <b>Gate settings changed outside Legion.</b>
            <span>Legion is using Ask for {list(view.changedOutside)} until you decide.</span>
            <ul className="gates-banner-list">
              {view.changedOutside.map((n) => (
                <li key={n}>
                  <span>{nameOf(n)}</span>
                  <button type="button" className="btn sm" disabled={busy || !view.canSign} onClick={() => void run({ kind: 'accept', name: n }, `Using the settings found in the file for ${nameOf(n)}.`)}>Accept</button>
                  <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void run({ kind: 'keep', name: n }, `Kept your settings for ${nameOf(n)}.`)}>Keep mine</button>
                </li>
              ))}
            </ul>
            {!view.canSign && <span>Accept is off. {KEYSTORE_LINE}</span>}
          </>
        )}
        {view.unreadable.length > 0 && (
          <>
            <span>The gate settings for {list(view.unreadable)} could not be read, so Legion is using Ask for {view.unreadable.length === 1 ? 'it' : 'them'}.</span>
            <span><button type="button" className="btn-ghost sm" disabled={busy || reloading} onClick={() => void doReload()}>Reload</button></span>
            {reload?.tone === 'error' && <span role="alert">{reload.text}</span>}
            {reload && reload.tone !== 'error' && <span role="status">Still cannot be read.</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** Settings, Gates, "How agents ask": the scope switch and the four presets, with what each one means. */
export function GatesPresets({ view, scope, setScope, projects, agents, busy, note, run }: {
  view: GatesView; scope: string; setScope: (s: string) => void; projects: readonly Project[]; agents: readonly AgentProfile[];
  busy: boolean; note: Note | null; run: (c: GatesChangeRequest, done: string) => Promise<boolean>;
}) {
  const isApp = scope === EVERYTHING;
  const project = isApp ? undefined : projects.find((p) => p.id === scope);
  const sum = scopeSummary(view, isApp ? undefined : scope);
  const choices = presetChoices();
  const change = (patch: Record<string, unknown>, done: string) => run(isApp ? { kind: 'app', patch } : { kind: 'project', id: scope, patch }, done);
  const current: Preset | 'per-agent' = isApp ? (view.app.preset ?? 'ask') : sum.preset;
  const setPreset = (p: Preset | null) => void change({ preset: p }, p === null ? `Agents in ${project?.name ?? 'this project'} use their own settings again.` : `Preset set to ${choices.find((c) => c.id === p)?.label}.`);
  const groupName = `gates-preset-${scope}`;
  return (
    <div className="set-card gates-presets" aria-label="How agents ask">
      <h3>How agents ask</h3>
      <div className="set-field">
        <label className="set-label" htmlFor="gates-scope">Applies to</label>
        <select id="gates-scope" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)}>
          <option value={EVERYTHING}>Everything (app default)</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      {!view.canSign && <p className="gates-warn"><Icon name="warn" size={13} /> <span>{KEYSTORE_LINE}</span></p>}
      <fieldset className="gates-fs" role="radiogroup" disabled={busy}>
        <legend className="set-label">{isApp ? 'Default for every project' : `Preset for ${project?.name ?? 'this project'}`}</legend>
        {!isApp && (
          <label className="gates-row gates-choice">
            <input type="radio" name={groupName} checked={current === 'per-agent'} onChange={() => setPreset(null)} />
            <span><b>Per agent</b><span className="field-note">Each agent uses its own setting, as before</span></span>
          </label>
        )}
        {choices.map((c) => {
          const why = disabledReason(view, c.id);
          return (
            <label key={c.id} className={`gates-row gates-choice${why ? ' off' : ''}`}>
              <input type="radio" name={groupName} checked={current === c.id} disabled={!!why} onChange={() => setPreset(c.id)} />
              <span><b>{c.label}</b><span className="field-note">{why ?? c.line}</span></span>
            </label>
          );
        })}
      </fieldset>
      {!isApp && (
        <>
          <label className="gates-row gates-choice">
            <input type="checkbox" checked={sum.limit} disabled={busy || sum.preset === 'per-agent'} onChange={(e) => void change({ limit: e.target.checked }, e.target.checked ? 'Agents are limited to this preset.' : 'Agents may go beyond this preset.')} />
            <span><b>Limit agents to this</b><span className="field-note">Agents with their own mode cannot go beyond this</span></span>
          </label>
          <p className="field-note" role="status">{sum.preset === 'per-agent' ? 'Each agent in this project uses its own setting.' : agentsFollowLine(agents, project?.members ?? [], sum.limit)}</p>
        </>
      )}
      <GatesNote note={note} pending={busy} />
      <p className="gates-text">{PAGE_NOTES.noSandbox}</p>
      <p className="gates-text">{PAGE_NOTES.web}</p>
    </div>
  );
}
