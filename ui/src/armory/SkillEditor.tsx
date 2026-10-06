/**
 * The editor for a skill or a drill: one dialog, two uses. Armory → New skill / Edit saves through /api/armory/skill; Doctrine →
 * Your drills → New drill / Edit saves through /api/house/drill. The caller says which with `onSave`; this file only draws the form.
 *
 * Fields mirror what the core accepts (name [a-z0-9-], description up to 500, an optional "when to use", a Markdown body) and are
 * checked live with the same rules (src/shared/armory-view.ts). Every message that comes back from the core is shown inline, in
 * plain words, with the form kept as it was, so a failed save loses nothing.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import {
  bodyCounter, counter, editorErrors, editorOk, endSentence, LIMITS, looksLikeSecret, nameError, nameSuggestion, NAME_RULE, newSkillCommand, parseSkillMd, SECRET_WARNING,
} from '../../../src/shared/armory-view';
import type { EditorFields } from '../../../src/shared/armory-view';
import './armory.css';

export interface SkillEditorProps {
  kind: 'skill' | 'drill';
  /** Edit an existing one: the name is fixed (it is the id). Reads the current SKILL.md text. */
  edit?: { name: string; loadText: () => Promise<string> };
  /** Names already taken, so a new one cannot silently replace an old one. */
  taken?: readonly string[];
  /** Saves. Throws the core's message. */
  onSave: (f: EditorFields) => Promise<void>;
  onClose: () => void;
}

const WORDS = {
  skill: { noun: 'skill', title: 'skill' },
  drill: { noun: 'drill', title: 'drill' },
} as const;

export function SkillEditor(p: SkillEditorProps) {
  const [loaded, setLoaded] = useState<{ fields: EditorFields; extraKeys: string[] } | null>(p.edit ? null : { fields: { name: '', description: '', whenToUse: '', body: '' }, extraKeys: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!p.edit);
  // Cancel and Save live in the dialog's own footer (always on screen, like every other dialog), which the dialog draws; the form puts its buttons in it.
  const [foot, setFoot] = useState<HTMLElement | null>(null);
  const retry = useRef<HTMLButtonElement>(null);
  // Esc, the X and a click outside all come through here, so none of them can throw away a draft without asking.
  const guard = useRef<(() => void) | null>(null);
  const load = (): void => {
    if (!p.edit) return;
    setLoading(true);
    setLoadError(null);
    p.edit.loadText()
      .then((text) => {
        const d = parseSkillMd(text);
        setLoaded({ fields: { name: p.edit!.name, description: d.description, whenToUse: d.whenToUse, body: d.body }, extraKeys: d.extraKeys });
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loadError) retry.current?.focus(); }, [loadError]);

  const verb = p.edit ? 'Edit' : 'New';
  const title = `${verb} ${WORDS[p.kind].title}`;
  // Portalled to the body: the screens that host it are containers, and a container would trap a fixed dialog inside the column.
  return createPortal(
    <Modal title={title} width={680} onClose={() => (guard.current ? guard.current() : p.onClose())}
      footer={loaded ? <div ref={setFoot} className="arm-footslot" /> : undefined}>
      {loading ? <div className="set-loading"><span className="spin" /> Reading the {WORDS[p.kind].noun}{'…'}</div> : null}
      {loadError ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`Could not read this ${WORDS[p.kind].noun}: ${loadError}`)}</span>
          <button ref={retry} type="button" className="btn sm" onClick={load}>Try again</button>
        </div>
      ) : null}
      {loaded ? <EditorForm {...p} guard={guard} foot={foot} start={loaded.fields} extraKeys={loaded.extraKeys} /> : null}
    </Modal>,
    document.body,
  );
}

function EditorForm({ kind, edit, taken, onSave, onClose, start, extraKeys, guard, foot }: SkillEditorProps & { start: EditorFields; extraKeys: string[]; guard: { current: (() => void) | null }; foot: HTMLElement | null }) {
  const [f, setF] = useState<EditorFields>(start);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const formId = useId();
  const saveErrEl = useRef<HTMLDivElement>(null);
  const ids = { name: useId(), nameHint: useId(), description: useId(), when: useId(), body: useId(), nameErr: useId(), descErr: useId(), whenErr: useId(), bodyErr: useId(), tabs: useId() };
  const refs = { name: useRef<HTMLInputElement>(null), description: useRef<HTMLTextAreaElement>(null), whenToUse: useRef<HTMLTextAreaElement>(null), body: useRef<HTMLTextAreaElement>(null) };
  const keepEditing = useRef<HTMLButtonElement>(null);
  const saveBtn = useRef<HTMLButtonElement>(null);
  const noun = WORDS[kind].noun;
  const err = useMemo(() => editorErrors(f, edit ? [] : taken, noun), [f, edit, taken, noun]);
  const dirty = f.name !== start.name || f.description !== start.description || f.whenToUse !== start.whenToUse || f.body !== start.body;
  const show = (k: keyof EditorFields): string => (attempted || touched[k] ? err[k] : '');
  // The name's message without its "Try x." tail: the suggestion is a button of its own, and the rule stays visible beside any error.
  const suggestion = show('name') ? nameSuggestion(f.name) : '';
  const nameMsg = show('name') ? nameError(f.name, edit ? [] : taken, false) : '';
  const touch = (k: keyof EditorFields): void => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const upd = (k: keyof EditorFields, v: string): void => { setF((x) => ({ ...x, [k]: v })); setSaveError(null); };

  const requestClose = (): void => { if (dirty && !busy) setConfirmDiscard(true); else if (!busy) onClose(); };
  guard.current = requestClose;
  useEffect(() => () => { guard.current = null; }, [guard]);
  useEffect(() => { if (confirmDiscard) keepEditing.current?.focus(); }, [confirmDiscard]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setAttempted(true);
    if (!editorOk(err)) {
      setTab('write');
      const first = (['name', 'description', 'whenToUse', 'body'] as const).find((k) => err[k]);
      // after the tab has switched back, so the field exists
      if (first) window.setTimeout(() => (first === 'name' && edit ? refs.description : refs[first]).current?.focus(), 0);
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await onSave({ ...f, name: f.name.trim() });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      saveBtn.current?.focus();
      // The footer stays on screen while the form scrolls, so the message has to be brought into view too.
      window.setTimeout(() => saveErrEl.current?.scrollIntoView?.({ block: 'nearest' }), 0);
    } finally {
      setBusy(false);
    }
  };

  const secret = looksLikeSecret(`${f.description}\n${f.whenToUse}\n${f.body}`);
  const tabKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const to = e.key === 'ArrowLeft' || e.key === 'Home' ? 'write' : 'preview';
      setTab(to);
      document.getElementById(`${ids.tabs}-${to}`)?.focus();
    }
  };

  const guide = kind === 'drill'
    ? 'A drill is a few fundamental steps that you vouch for. It starts not approved and off. You approve it in Doctrine after you save, and again after every edit.'
    : edit
      ? 'Saving changes this skill for every agent that can use it.'
      : 'A new skill starts off. After you save it, turn it on from its row, and an agent sees its description and opens it when a task fits.';

  return (
    <form id={formId} className="form arm-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p className="set-hint arm-guide">{guide}</p>
      {extraKeys.length ? (
        <p className="arm-banner" role="note">
          This file has other settings in its header ({extraKeys.join(', ')}). Saving here keeps only the name and the description.
        </p>
      ) : null}

      <div className="arm-field">
        <label htmlFor={ids.name}>Name</label>
        <input id={ids.name} ref={refs.name} value={f.name} readOnly={!!edit} data-autofocus={edit ? undefined : true} spellCheck={false} autoComplete="off"
          aria-invalid={show('name') ? true : undefined} aria-describedby={`${ids.nameErr} ${ids.nameHint}`} placeholder={kind === 'drill' ? 'my-drill' : 'my-skill'} maxLength={64}
          onChange={(e) => upd('name', e.target.value)} onBlur={() => touch('name')} className="arm-mono" />
        {show('name') ? (
          <span id={ids.nameErr} className="arm-fielderr" role="alert">
            {nameMsg}
            {suggestion ? <> Try <button type="button" className="link-btn arm-suggest" onClick={() => { upd('name', suggestion); setTouched((t) => ({ ...t, name: true })); refs.name.current?.focus(); }}>{suggestion}</button>.</> : null}
          </span>
        ) : <span id={ids.nameErr} hidden />}
        {/* The hint stays under the error, so a name that is refused still shows what a good one looks like. */}
        <span id={ids.nameHint} className="field-note">
          {kind === 'drill'
            ? (edit ? 'The name is the drill\'s name, so it cannot change. Make a new one to use another name.' : `It becomes the drill's name. ${NAME_RULE}`)
            : (edit ? `The name is its /command, so it cannot change. Make a new one to use another name.` : `It becomes the /command: ${newSkillCommand(f.name)}. ${NAME_RULE}`)}
        </span>
      </div>

      <div className="arm-tabs" role="tablist" aria-label="Write or preview" onKeyDown={tabKey}>
        <button type="button" role="tab" id={`${ids.tabs}-write`} aria-selected={tab === 'write'} aria-controls={`${ids.tabs}-panel`} tabIndex={tab === 'write' ? 0 : -1} onClick={() => setTab('write')}>Write</button>
        <button type="button" role="tab" id={`${ids.tabs}-preview`} aria-selected={tab === 'preview'} aria-controls={`${ids.tabs}-panel`} tabIndex={tab === 'preview' ? 0 : -1} onClick={() => setTab('preview')}>Preview</button>
      </div>

      <div id={`${ids.tabs}-panel`} role="tabpanel" aria-labelledby={`${ids.tabs}-${tab}`} className="arm-panel">
        {tab === 'write' ? (
          <>
            <div className="arm-field">
              <label htmlFor={ids.description}>Description</label>
              <textarea id={ids.description} ref={refs.description} rows={3} value={f.description} data-autofocus={edit ? true : undefined}
                aria-invalid={show('description') ? true : undefined} aria-describedby={ids.descErr}
                onChange={(e) => upd('description', e.target.value)} onBlur={() => touch('description')}
                placeholder={`One or two sentences: what this ${noun} does.`} className="arm-short" />
              <span className="arm-fieldline">
                <span id={ids.descErr} className={show('description') ? 'arm-fielderr' : 'field-note'} role={show('description') ? 'alert' : undefined}>
                  {show('description') || `An agent reads this line to decide whether to open the ${noun}.`}
                </span>
                <span className="arm-count" >{counter(f.description, LIMITS.description)}</span>
              </span>
            </div>
            <div className="arm-field">
              <label htmlFor={ids.when}>When to use <span className="arm-opt">(optional)</span></label>
              <textarea id={ids.when} ref={refs.whenToUse} rows={2} value={f.whenToUse} aria-invalid={show('whenToUse') ? true : undefined} aria-describedby={ids.whenErr}
                onChange={(e) => upd('whenToUse', e.target.value)} onBlur={() => touch('whenToUse')}
                placeholder="The kind of task that should make an agent reach for it." className="arm-short" />
              <span className="arm-fieldline">
                <span id={ids.whenErr} className={show('whenToUse') ? 'arm-fielderr' : 'field-note'} role={show('whenToUse') ? 'alert' : undefined}>
                  {show('whenToUse') || 'Added to the description as "Use when: …".'}
                </span>
                <span className="arm-count" >{counter(f.whenToUse, LIMITS.whenToUse)}</span>
              </span>
            </div>
            <div className="arm-field">
              <label htmlFor={ids.body}>Body (Markdown)</label>
              <textarea id={ids.body} ref={refs.body} rows={12} value={f.body} aria-invalid={show('body') ? true : undefined} aria-describedby={ids.bodyErr}
                onChange={(e) => upd('body', e.target.value)} onBlur={() => touch('body')} spellCheck={false}
                placeholder={'# What to do\n\n1. First step\n2. Second step'} className="arm-body" />
              <span className="arm-fieldline">
                <span id={ids.bodyErr} className={show('body') ? 'arm-fielderr' : 'field-note'} role={show('body') ? 'alert' : undefined}>
                  {show('body') || `What the agent reads once it opens the ${noun}.`}
                </span>
                <span className="arm-count">{bodyCounter(f.body)}</span>
              </span>
            </div>
          </>
        ) : (
          <div className="arm-preview">
            <p className="arm-prevname"><code>{kind === 'drill' ? (f.name || 'name') : newSkillCommand(f.name)}</code></p>
            <p className="arm-prevdesc">{f.description.replace(/\s+/g, ' ').trim() || <span className="arm-faint">No description yet.</span>}{f.whenToUse.trim() ? ` Use when: ${f.whenToUse.replace(/\s+/g, ' ').trim()}` : ''}</p>
            <div className="house-read house-readmd" tabIndex={0} role="region" aria-label={`Preview of the ${noun} text`}>
              {f.body.trim() ? <Markdown text={f.body} headingOffset={3} quietCode /> : <span className="arm-faint">Nothing in the body yet.</span>}
            </div>
          </div>
        )}
      </div>

      {secret ? <p className="arm-banner" role="status">{SECRET_WARNING}</p> : null}
      {saveError ? <div ref={saveErrEl} className="set-error" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not save: ${saveError}`)} What you wrote is still here.</span></div> : null}
      {confirmDiscard ? (
        <div className="arm-discard" role="alertdialog" aria-label="Discard changes">
          <span>Throw away what you wrote?</span>
          <button type="button" className="btn sm danger" onClick={onClose}>Discard</button>
          <button ref={keepEditing} type="button" className="btn sm" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
        </div>
      ) : null}

      {foot ? createPortal(
        <>
          <button type="button" className="btn-ghost" onClick={requestClose}>Cancel</button>
          <span className="spacer" />
          <button ref={saveBtn} type="submit" form={formId} className="btn primary" aria-disabled={busy} aria-busy={busy || undefined}>
            {busy ? <><span className="spin" /> Saving{'…'}</> : edit ? 'Save' : `Save ${noun}`}
          </button>
        </>,
        foot,
      ) : null}
    </form>
  );
}
