/**
 * The Armory's dialogs: Read a skill, choose which agents may use it, and the review step before adding a skill from disk.
 * All three use the app's Modal (focus trap, Esc, focus returns to the button that opened it).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { StateRadio } from './ArmoryControls';
import { closeRead, importSkill, openRead, reviewImportFiles, setSkillAgents, uniqueLabel, useArmory } from './armoryStore';
import {
  agentChecked, commandOf, endSentence, hiddenCharsLine, HIDDEN_TEXT_WHY, isReadable, parseSkillMd, plural, refusalLine, shortList, showHidden, sourceLabel,
} from '../../../src/shared/armory-view';
import type { AgentRef, ImportReview, SentFile } from '../../../src/shared/armory-view';
import './armory.css';

/** The full text of one skill, rendered as Markdown (never as HTML), with the skill's own three-state choice in the footer. */
export function ReadDialog() {
  const r = useArmory((s) => s.reading);
  const skill = useArmory((s) => (s.reading ? s.data?.skills.find((x) => x.id === s.reading!.id) : undefined));
  const text = r?.status === 'ready' ? r.text : '';
  const doc = useMemo(() => parseSkillMd(text), [text]);
  const readEl = useRef<HTMLDivElement>(null);
  const retryEl = useRef<HTMLButtonElement>(null);
  const status = r?.status;
  // The dialog opens while its text is loading, so Modal can only park focus on Close. Once the text is there (or the read
  // failed) focus goes to it, unless the owner has already moved on to something else in the dialog.
  useEffect(() => {
    if (!status || status === 'loading') return;
    const a = document.activeElement;
    const parked = !a || a === document.body || !!a.closest('.modal-head');
    if (!parked) return;
    (status === 'ready' ? readEl.current : retryEl.current)?.focus();
  }, [status, r?.id]);
  if (!r) return null;
  return createPortal(
    <Modal title={r.title} width={720} onClose={closeRead}
      footer={<>
        <span className="arm-readpath" title={r.path ?? undefined}>{r.path ?? commandOf(skill ?? { id: r.id })}</span>
        <span className="spacer" />
        {skill ? <StateRadio skill={skill} caption="Use this skill" /> : null}
        <button type="button" className="btn" onClick={closeRead}>Done</button>
      </>}>
      {r.status === 'loading' ? <div className="set-loading"><span className="spin" /> Reading the skill{'…'}</div> : null}
      {r.status === 'error' ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`Could not read this skill: ${r.error ?? 'unknown error'}`)}</span>
          <button ref={retryEl} type="button" className="btn sm" onClick={() => void openRead(r.id, r.title)}>Try again</button>
        </div>
      ) : null}
      {r.status === 'builtin' ? (
        <div className="arm-readbody">
          {skill?.description ? <p className="house-readdesc">{skill.description}</p> : null}
          <p className="set-hint">This skill is built in to Claude Code, so its text is not on this computer to read here.</p>
          {skill?.offReason ? <p className="set-hint">Legion keeps it off. {skill.offReason}</p> : null}
        </div>
      ) : null}
      {r.status === 'ready' ? (
        <div className="arm-readbody">
          {skill ? <p className="house-readmeta"><code>{commandOf(skill)}</code> · {sourceLabel(skill)}</p> : null}
          {doc.description || doc.whenToUse ? <p className="house-readdesc">{showHidden(doc.description)}{doc.whenToUse ? ` Use when: ${showHidden(doc.whenToUse)}` : ''}</p> : null}
          {r.thirdParty ? <p className="set-hint">Not written by you. A run that opens it is treated as having read outside text, so Legion keeps its limits on.</p> : null}
          {doc.extraKeys.length ? <p className="set-hint">Header settings in this file: {doc.extraKeys.join(', ')}.</p> : null}
          <div ref={readEl} className="house-read house-readmd" tabIndex={0} data-autofocus role="region" aria-label={`Text of ${r.title}`}>
            <Markdown text={showHidden(doc.body || text)} headingOffset={2} quietCode />
          </div>
        </div>
      ) : null}
    </Modal>,
    document.body,
  );
}

/** Which agents may pick a skill up on their own. The rest can still run it when the owner types its /command. */
export function AgentsDialog({ id, agents, onClose }: { id: string; agents: readonly AgentRef[]; onClose: () => void }) {
  const skill = useArmory((s) => s.data?.skills.find((x) => x.id === id));
  const err = useArmory((s) => (s.rowErrors[id]?.op === 'agents' ? s.rowErrors[id]!.message : null));
  const busy = useArmory((s) => s.switching.includes(id));
  const start = skill?.agents ?? 'all';
  const [all, setAll] = useState(start === 'all');
  const [chosen, setChosen] = useState<string[]>(start === 'all' ? agents.map((a) => a.id) : [...start]);
  const gid = useId();
  const save = async (): Promise<void> => {
    if (busy) return;
    const grant = all || (agents.length > 0 && agents.every((a) => chosen.includes(a.id))) ? 'all' : chosen;
    if (await setSkillAgents(id, grant)) onClose();
  };
  if (!skill) return null;
  return createPortal(
    <Modal title={`Agents for ${uniqueLabel(skill)}`} width={460} onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <span className="spacer" />
        <button type="button" className="btn primary" aria-disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
          {busy ? <><span className="spin" /> Saving{'…'}</> : 'Save'}
        </button>
      </>}>
      <p className="set-hint arm-guide">Agents you leave out do not pick this skill up on their own. You can still run it for them by typing {commandOf(skill)}.</p>
      <fieldset className="arm-agents" aria-labelledby={gid}>
        <legend id={gid} className="sr-only">Which agents</legend>
        <label className="arm-check"><input type="radio" name={`${gid}-mode`} checked={all} onChange={() => setAll(true)} data-autofocus /> All agents</label>
        <label className="arm-check"><input type="radio" name={`${gid}-mode`} checked={!all} onChange={() => setAll(false)} /> Only these agents</label>
        <ul className="arm-agentlist" aria-label="Agents">
          {agents.map((a) => (
            <li key={a.id}>
              <label className={`arm-check${all ? ' dim' : ''}`}>
                <input type="checkbox" checked={all || agentChecked(chosen, a.id)} aria-disabled={all || undefined} tabIndex={all ? -1 : undefined}
                  onChange={(e) => { if (all) return; setChosen((c) => (e.target.checked ? [...new Set([...c, a.id])] : c.filter((x) => x !== a.id))); }} />
                {a.name}
              </label>
            </li>
          ))}
          {!agents.length ? <li className="set-hint">No agents to choose from yet.</li> : null}
        </ul>
      </fieldset>
      {!all && chosen.filter((c) => agents.some((a) => a.id === c)).length === 0 ? <p className="set-hint">No agent is chosen, so none will pick this skill up on its own.</p> : null}
      {err ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not save: ${err}`)}</span></div> : null}
    </Modal>,
    document.body,
  );
}

/** What the picker handed over: the File and the path to send. */
export interface PickedSource { file: File; path: string }

const readText = (f: File): Promise<string> => f.text();

/**
 * The review step: what a folder or a SKILL.md would add, BEFORE anything is written. The core does the review (a dry run: it
 * writes nothing) and the screen only shows its answer: the files kept and left out (and why), the header settings that would be
 * removed, any reason it refuses, and the SKILL.md as it would be written. Add puts it in the Armory off. Only .md files small
 * enough to keep are read here; every other file goes to the core as a name and a size, so its bytes stay on the disk.
 */
export function ImportDialog({ picked, skipped, onClose }: { picked: PickedSource[]; skipped: number; onClose: () => void }) {
  const [review, setReview] = useState<ImportReview | null>(null);
  const [sent, setSent] = useState<SentFile[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    void (async () => {
      const files: SentFile[] = [];
      try {
        for (const p of picked) files.push(isReadable(p.path, p.file.size) ? { path: p.path, text: await readText(p.file) } : { path: p.path, size: p.file.size, text: null });
      } catch (e) {
        if (alive.current) setReadError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!alive.current) return;
      setSent(files);
      try {
        const r = await reviewImportFiles(files);
        if (alive.current) setReview(r);
      } catch (e) {
        if (alive.current) setCheckError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [picked]);

  const doc = useMemo(() => parseSkillMd(review?.skillText ?? ''), [review]);
  const add = async (): Promise<void> => {
    if (!review?.ok || busy) return;
    setBusy(true);
    setAddError(null);
    try {
      await importSkill(sent);
      onClose();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
      addBtn.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  // The review is the thing to read, so focus lands there; a refusal puts focus on the way out.
  const readEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!review) return;
    const a = document.activeElement;
    const parked = !a || a === document.body || !!a.closest('.modal-head');
    if (!parked) return;
    (review.ok ? readEl.current : closeBtn.current)?.focus();
  }, [review]);

  return createPortal(
    <Modal title="Add a skill from disk" width={720} onClose={onClose}
      footer={<>
        <button ref={closeBtn} type="button" className="btn-ghost" onClick={onClose}>{review?.ok ? 'Cancel' : 'Close'}</button>
        <span className="spacer" />
        {review?.ok ? (
          <button ref={addBtn} type="button" className="btn primary" aria-disabled={busy} aria-busy={busy || undefined} onClick={() => void add()}>
            {busy ? <><span className="spin" /> Adding{'…'}</> : 'Add (off)'}
          </button>
        ) : null}
      </>}>
      {!review && !readError && !checkError ? <div className="set-loading"><span className="spin" /> Reading the files{'…'}</div> : null}
      {readError ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not read these files: ${readError}`)}</span></div> : null}
      {checkError ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not check these files: ${checkError}`)}</span></div> : null}
      {review && !review.ok ? (
        <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{refusalLine(review.refusal)}</span></div>
      ) : null}
      {review?.ok ? (
        <div className="arm-review">
          <p className="arm-revhead"><strong>{showHidden(review.name)}</strong> <code>{showHidden(commandOf({ id: review.id }))}</code></p>
          <p className="set-hint">It will be added <strong>off</strong>. Agents do not see it until you turn it on.</p>
          {skipped ? <p className="set-hint">{plural(skipped, 'file')} in hidden or tool folders {skipped === 1 ? 'was' : 'were'} not looked at.</p> : null}

          <h4 className="arm-revh">Kept ({review.kept.length})</h4>
          <p className="arm-paths">{shortList(review.kept, 8)}</p>

          {review.dropped.length ? (
            <>
              <h4 className="arm-revh">Left out ({review.dropped.length})</h4>
              <ul className="arm-dropped">
                {review.dropped.slice(0, 12).map((d) => <li key={d.path}><code>{d.path}</code> <span className="arm-why">{d.reason}</span></li>)}
              </ul>
              {review.dropped.length > 12 ? <p className="set-hint">and {review.dropped.length - 12} more.</p> : null}
            </>
          ) : null}

          {review.stripped.length ? (
            <p className="arm-banner" role="note">
              Removed from the header: {review.stripped.join(', ')}. Legion's own code removed these keys, so this skill does not get them.
            </p>
          ) : null}

          {hiddenCharsLine(review.hiddenChars) ? (
            <p className="arm-banner" role="note">{hiddenCharsLine(review.hiddenChars)} {HIDDEN_TEXT_WHY}</p>
          ) : null}

          <h4 className="arm-revh">What agents would read</h4>
          {doc.description ? <p className="house-readdesc">{showHidden(doc.description)}{doc.whenToUse ? ` Use when: ${showHidden(doc.whenToUse)}` : ''}</p> : null}
          <div ref={readEl} className="house-read house-readmd" tabIndex={0} data-autofocus role="region" aria-label="The SKILL.md as it would be added">
            <Markdown text={showHidden(doc.body)} headingOffset={3} quietCode />
          </div>
        </div>
      ) : null}
      {addError ? <div className="set-error arm-adderr" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not add it: ${addError}`)}</span></div> : null}
    </Modal>,
    document.body,
  );
}
