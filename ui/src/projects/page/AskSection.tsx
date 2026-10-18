/**
 * Project settings, "How agents ask": the preset radio and the limit checkbox of Settings, Gates, for this one project, and the one-time notice
 * that projects can now set this. Every change goes through the same native confirm as the Gates page (useGatesAction); the result is always shown.
 */
import type { AgentProfile } from '../../../../src/shared/types';
import type { Preset } from '../../../../src/shared/gates-registry';
import type { Project } from '../../../../src/shared/projects';
import { PROJECT_NOTICE, limitWords, shouldShowProjectNotice } from '../../gates/agentFollowLogic';
import { disabledReason, presetChoices, scopeSummary, type GatesView } from '../../gates/presetsLogic';
import { useGatesAction, useGatesView, type GatesChangeRequest, type GatesNote } from '../../gates/useGatesView';
import { useStore } from '../../store';
import { announce } from './announce';

type Run = (c: GatesChangeRequest, done: string) => Promise<boolean>;

function ResultLine({ note, pending }: { note: GatesNote | null; pending: boolean }) {
  if (pending) return <p className="pg-ask-result" role="status">Waiting for you to confirm in the window</p>;
  if (!note) return null;
  if (note.tone === 'error') return <div className="ferr" role="alert">{note.text}</div>;
  return <p className="pg-ask-result" role="status">{note.text}</p>;
}

/** The drawn section. State comes in as props so a test can render every state. */
export function AskSectionView({ project, agents, view, busy, note, run }: { project: Project; agents: readonly AgentProfile[]; view: GatesView; busy: boolean; note: GatesNote | null; run: Run }) {
  const sum = scopeSummary(view, project.id);
  const words = limitWords(agents, project, view);
  const choices = presetChoices();
  const name = `ask-preset-${project.id}`;
  const change = (patch: Record<string, unknown>, done: string): void => { void run({ kind: 'project', id: project.id, patch }, done).then((ok) => { if (ok) announce(done); }); };
  const setPreset = (p: Preset | null): void => change({ preset: p }, p === null ? `Agents in ${project.name} use their own settings again.` : `Preset set to ${choices.find((c) => c.id === p)?.label}.`);
  return (
    <section data-sec="ask" aria-labelledby="set-h-ask">
      <h2 id="set-h-ask" tabIndex={-1}>How agents ask</h2>
      <p className="lead">Choose how much agents ask while they work on this project. Changing it to something looser shows a confirmation in a separate window.</p>
      <div className="pg-opt" role="radiogroup" aria-labelledby="ask-preset-l">
        <div>
          <b id="ask-preset-l">Preset for {project.name}</b>
          <span className="h">{sum.preset === 'per-agent' ? 'No preset is set for this project.' : choices.find((c) => c.id === sum.preset)?.line}</span>
        </div>
        <div className="ctl col">
          <div className="pg-ask-row">
            <label className="pg-radio"><input type="radio" name={name} checked={sum.preset === 'per-agent'} disabled={busy} onChange={() => setPreset(null)} /><span>Per agent</span><span className="pg-tag">Default</span></label>
            <span className="h">Each agent uses its own setting, as before.</span>
          </div>
          {choices.map((c) => {
            const why = disabledReason(view, c.id);
            return (
              <div key={c.id} className="pg-ask-row">
                <label className="pg-radio"><input type="radio" name={name} checked={sum.preset === c.id} disabled={busy || !!why} onChange={() => setPreset(c.id)} /><span>{c.label}</span></label>
                <span className="h">{why ?? c.line}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pg-opt">
        <div>
          <b id="ask-limit-l">Limit agents to this</b>
          <span className="h">Agents with their own setting can be stricter here, never looser.</span>
          {sum.preset !== 'per-agent' && sum.limit && words.on && <span className="h" role="status" data-testid="limit-line">{words.on}</span>}
          {sum.preset !== 'per-agent' && !sum.limit && words.off && <span className="pg-limit-warn" role="status" data-testid="limit-warn">{words.off}</span>}
        </div>
        <div className="ctl">
          <label className="pg-radio"><input type="checkbox" aria-labelledby="ask-limit-l" checked={sum.limit} disabled={busy || sum.preset === 'per-agent'} onChange={(e) => change({ limit: e.target.checked }, e.target.checked ? 'Agents are limited to this preset.' : 'Agents may go beyond this preset.')} /></label>
        </div>
      </div>
      <ResultLine note={note} pending={busy} />
    </section>
  );
}

export function AskSection({ project }: { project: Project }) {
  const agents = useStore((s) => s.agents);
  const { view, apply } = useGatesView();
  const { pending, note, run } = useGatesAction(apply);
  if (!view) return null;
  return <AskSectionView project={project} agents={agents} view={view} busy={pending} note={note} run={run} />;
}

/** The notice at the top of the page: once, for an install that had projects before this version. */
export function ProjectNoticeView({ busy, note, onDismiss }: { busy: boolean; note: GatesNote | null; onDismiss: () => void }) {
  return (
    <div className="pg-notice" role="status" aria-label="New in projects">
      <p>{PROJECT_NOTICE.text}</p>
      <button type="button" className="pg-btn" disabled={busy} onClick={onDismiss}>{PROJECT_NOTICE.dismiss}</button>
      {note?.tone === 'error' && <div className="ferr" role="alert">{note.text}</div>}
    </div>
  );
}

export function ProjectNotice() {
  const projectCount = useStore((s) => s.projects.length);
  const { view, apply } = useGatesView();
  const { pending, note, run } = useGatesAction(apply);
  if (!view || !shouldShowProjectNotice(view, projectCount)) return null;
  return <ProjectNoticeView busy={pending} note={note} onDismiss={() => { void run({ kind: 'app', patch: { noticeSeen: true } }, PROJECT_NOTICE.dismiss).then((ok) => { if (ok) announce('Done. You will not see this note again.'); }); }} />;
}
