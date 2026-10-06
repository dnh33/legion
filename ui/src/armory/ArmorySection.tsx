/**
 * Settings → Armory: the skills your agents can pick up when a task calls for one.
 *
 * Skills are not rules. The Armory is the open library (many, loose, yours to add); Doctrine → Drills is the short list you vouch for.
 * Three separate decisions live on a row and must not blur:
 *  - the STATE: "Agents decide", "Only when I ask" or "Off";
 *  - WHICH AGENTS may pick it up on their own;
 *  - where it came from (the source tag), which decides how Legion treats a run that opens it.
 *
 * Grouping, order, labels and counts come from src/shared/armory-view.ts (pure, tested). This file only draws them.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { openEditor, setSettingsSection, useStore } from '../store';
import { loadHouse, markHouseFresh } from '../house/houseStore';
import { focusIntent, focusWhenReady } from './lateFocus';
import type { FocusIntent } from './lateFocus';
import { AgentsDialog, ImportDialog, ReadDialog } from './ArmoryDialogs';
import type { PickedSource } from './ArmoryDialogs';
import { Note, RowMenu, StateRadio } from './ArmoryControls';
import type { MenuItem } from './ArmoryControls';
import { SkillEditor } from './SkillEditor';
import { SnackSlot, Toast } from './Snack';
import { Description } from './Description';
import {
  bulkCount, bulkSet, clearFocusRow, clearRemoved, clearUndone, consequenceOf, dismissNotice, dismissPromoted, getArmory, holdRemoved, holdUndo, loadArmory, loadEffective, loadEffectiveAll, openRead, promoteSkill,
  readSkillText, refreshDiscovery, setSkillState, releaseRemoved, releaseUndo, removeSkill, retryLoad, saveSkill, setAgentContext, setAllowShell, showPromotedDrill, turnAllOn,
  undoBulk, undoRemove, uniqueLabel, useArmory,
} from './armoryStore';
import {
  agentsButtonName, agentsLabel, budgetSummary, bulkLabel, bulkName, buildGroups, commandView, endSentence, FILTERS, groupLabel,
  discoveryLine, HIDDEN_TEXT_FLAG, HIDDEN_TEXT_WHY, discoveryWarning, HEADER_TEXT, isJunkPath, KEPT_OFF_TAG, lockedNote, matchCount, nextHeader, NOTICE_TEXT, parseOpen, plural, rowTag, runsNote, SHELL_ON_LINE, SHELL_SCOPE, SHELL_WARNING, shellConfirm, seesText, showSearch,
  STATE_FILTERS, stateLabel, totalLine, turnAllOnTargets,
} from '../../../src/shared/armory-view';
import type { AgentRef, ArmoryData, ArmoryFilter, ArmoryGroup, ArmorySkill, ArmoryStateFilter, BulkConsequence } from '../../../src/shared/armory-view';
import '../house/house.css';
import './armory.css';

const OPEN_KEY = 'legion.armory.groupsOpen';

type EditorTarget = { mode: 'new' } | { mode: 'edit'; skill: ArmorySkill };

export function ArmorySection() {
  const data = useArmory((s) => s.data);
  const loaded = useArmory((s) => s.loaded);
  const loadError = useArmory((s) => s.loadError);
  const loading = useArmory((s) => s.loading);
  const refreshing = useArmory((s) => s.refreshing);
  const refreshError = useArmory((s) => s.refreshError);
  const absent = useArmory((s) => s.absent);
  const notice = useArmory((s) => s.notice);
  const highlight = useArmory((s) => s.highlight);
  const reveal = useArmory((s) => s.reveal);
  const promoted = useArmory((s) => s.promoted);
  const agentsAll = useStore((s) => s.agents);
  const agents: AgentRef[] = useMemo(() => agentsAll.map((a) => ({ id: a.id, name: a.name })), [agentsAll]);

  const [filter, setFilter] = useState<ArmoryFilter>('all');
  const [stateFilter, setStateFilter] = useState<ArmoryStateFilter>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ files: PickedSource[]; skipped: number } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return parseOpen(window.localStorage.getItem(OPEN_KEY)); } catch { return {}; }
  });
  const searchBox = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retried = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const wantRemovedFocus = useRef<FocusIntent | null>(null);
  const wantPromotedFocus = useRef<FocusIntent | null>(null);
  const revealed = useRef<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const rootEl = useRef<HTMLDivElement>(null);
  const savedRow = useRef<string | null>(null);
  // Where the Undo bars and the Promote bar are drawn: a strip that overlays the top of the visible list, so a bar appearing moves nothing.
  const [toastEl, setToastEl] = useState<HTMLDivElement | null>(null);
  const focusRow = useArmory((s) => s.focusRow);
  // "Listed 3 minutes ago" moves on by itself.
  const [nowMs, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (data) setNow(Date.now()); }, [data?.discoveredAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-read on entry: Claude Code skills may have changed on disk since this screen was last open.
  useEffect(() => { void loadArmory(); void loadHouse({ maxAgeMs: 5000 }); }, []);
  // The agents (and so what each would see) are needed to say a consequence before a bulk change.
  useEffect(() => { setAgentContext(agentsAll.map((a) => ({ id: a.id, name: a.name, skills: a.skills }))); }, [agentsAll]);
  // The Promote bar belongs to this visit: it does not follow the owner to another screen.
  useEffect(() => () => { dismissPromoted(); clearUndone(); }, []);
  // Agents may be needed for the Agents choice; the app loads them at start.
  useEffect(() => {
    if (retried.current && loaded && !loadError) { retried.current = false; heading.current?.focus(); }
  }, [loaded, loadError]);

  const skills = data?.skills ?? [];
  const searchable = showSearch(skills);
  const q = searchable ? query.trim() : '';
  const narrowed = !!q || stateFilter !== 'all';
  const groups = useMemo(() => buildGroups(skills, filter, q, stateFilter), [skills, filter, q, stateFilter]);
  // "Open in the Armory" from the agent editor: show everything, open the group, scroll to the row and focus it.
  useEffect(() => { if (reveal && loaded) { setFilter('all'); setStateFilter('all'); setQuery(''); } if (!reveal) revealed.current = null; }, [reveal, loaded]);
  useEffect(() => {
    if (!reveal || revealed.current === reveal) return;
    const el = wrap.current?.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(reveal)}"]`);
    if (el) { revealed.current = reveal; el.scrollIntoView?.({ block: 'center' }); el.focus(); }
  });
  // After Undo of a Remove the bar that held focus is gone: the restored row takes it, as soon as that row is drawn (the list is re-read first).
  useEffect(() => {
    if (!focusRow) return;
    const id = focusRow;
    const intent = focusIntent(rootEl.current);
    return focusWhenReady({
      find: () => wrap.current?.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(id)}"]`) ?? null,
      fallback: () => heading.current, wanted: () => intent.still(),
      done: () => { intent.done(); clearFocusRow(); },
    });
  }, [focusRow]);
  const retry = (): void => { retried.current = true; void retryLoad(); };
  const toggle = (g: ArmoryGroup, isOpen: boolean): void => {
    const next = { ...open, [g.key]: !isOpen };
    // Only a choice that differs from the default is remembered.
    if (next[g.key] === !g.collapsed) delete next[g.key];
    setOpen(next);
    try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* works without storage */ }
  };
  const move = (e: React.KeyboardEvent, i: number): void => {
    const heads = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[data-arm-gh]') ?? []);
    const to = nextHeader(e.key, i, heads.length);
    if (to === null) return;
    e.preventDefault();
    heads[to]?.focus();
  };

  const onPick = async (list: FileList | null, folder: boolean): Promise<void> => {
    const all = Array.from(list ?? []);
    if (!all.length) return;
    const files: PickedSource[] = [];
    let skipped = 0;
    for (const f of all) {
      // A lone .md file is the skill itself, whatever it is called. A folder keeps its own paths, so the folder name can name the skill.
      const path = folder ? ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name) : 'SKILL.md';
      if (folder && isJunkPath(path)) { skipped++; continue; }
      files.push({ file: f, path });
    }
    setPicked({ files, skipped });
  };

  const goDoctrine = (): void => setSettingsSection('house');
  // Promote already re-read Doctrine, so opening it does not ask again.
  const openPromoted = (): void => { markHouseFresh(); showPromotedDrill(); setSettingsSection('house'); };

  if (absent) {
    return (
      <div className="set-section">
        <header className="set-head"><h3 ref={heading} tabIndex={-1}>Armory</h3><p>This version of Legion has no Armory. Update to get it.</p></header>
      </div>
    );
  }
  if (loadError && !loaded) {
    return (
      <div className="set-section">
        <header className="set-head"><h3 ref={heading} tabIndex={-1}>Armory</h3></header>
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`Could not read your skills: ${loadError}`)}</span>
          <TryAgain loading={loading} onRetry={retry} />
        </div>
      </div>
    );
  }

  const total = skills.length;
  const mine = skills.filter((s) => s.source === 'yours' || s.source === 'imported').length;
  const found = matchCount(groups);
  const takenNames = skills.filter((s) => s.source === 'yours' || s.source === 'imported').map((s) => s.name);
  // The empty message below carries its own New skill button (and the count would only say "0 shown"): the toolbar and the count step aside.
  const emptyShown = !total || (!mine && filter === 'yours') || (filter === 'imported' && !skills.some((s) => s.source === 'imported'));
  const hasClaude = skills.some((s) => s.source === 'claude-personal' || s.source === 'claude-plugin');

  return (
    <div ref={rootEl} className="set-section house-cq arm" aria-busy={!loaded || undefined}>
      <header className="set-head">
        <h3 ref={heading} tabIndex={-1}>Armory</h3>
        <p>{HEADER_TEXT}</p>
        <p className="arm-cross">
          <button type="button" className="link-btn" onClick={goDoctrine}>Rules and drills live in Doctrine</button>
        </p>
      </header>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{notice}</div>

      {/* One state at a time: while Claude Code is asked again, or once that ask failed (it says so itself), the older stale-list notice waits. */}
      {loadError && loaded && !refreshing && !refreshError ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`This list may be out of date: ${loadError}`)}</span>
          <TryAgain loading={loading} onRetry={retry} />
        </div>
      ) : null}

      {/* The first read asks Claude Code what it loads, which can take several seconds: say so, and keep the room the list will fill. */}
      {!loaded ? <div className="set-loading arm-loading"><span className="spin" /> <span>Reading your Claude Code skills{'…'}</span></div> : null}

      {loaded && data ? (
        <>
          <Discovery data={data} nowMs={nowMs} refreshing={refreshing} error={refreshError} />
          <NoticeBar show={!data.ccNoticeSeen && hasClaude} heading={heading} toastEl={toastEl} />
          <RemovedBar wantFocus={wantRemovedFocus} heading={heading} toastEl={toastEl} />
          {promoted ? <PromotedBar wantFocus={wantPromotedFocus} onOpen={openPromoted} toastEl={toastEl} /> : null}

          <div className="arm-toolbar">
            <div className="arm-filters" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" className={`arm-filter${filter === f.id ? ' on' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <div className="arm-filters" role="group" aria-label="Which are on">
              {STATE_FILTERS.map((f) => (
                <button key={f.id} type="button" className={`arm-filter${stateFilter === f.id ? ' on' : ''}`} aria-pressed={stateFilter === f.id} onClick={() => setStateFilter(f.id)}>{f.label}</button>
              ))}
            </div>
            <div className="arm-actions">
              {emptyShown ? null : <button type="button" className="btn sm" onClick={() => setEditor({ mode: 'new' })}><Icon name="plus" size={12} /> New skill</button>}
              <AddMenu onFile={() => fileInput.current?.click()} onFolder={() => dirInput.current?.click()} />
            </div>
          </div>
          <input ref={fileInput} type="file" accept=".md,text/markdown" className="arm-hidden" tabIndex={-1} aria-hidden="true"
            onChange={(e) => { void onPick(e.target.files, false); e.target.value = ''; }} />
          {/* webkitdirectory is not in React's input types, so it is set on the element as it mounts (the input only exists once the list has loaded). */}
          <input ref={(el) => { dirInput.current = el; el?.setAttribute('webkitdirectory', ''); el?.setAttribute('directory', ''); }} type="file" className="arm-hidden" tabIndex={-1} aria-hidden="true"
            onChange={(e) => { void onPick(e.target.files, true); e.target.value = ''; }} />

          <p className="set-hint arm-legend">
            <b>Agents decide</b>: agents see the description and open the skill when a task fits. <b>Only when I ask</b>: it runs when you type its /command.
            {' '}<b>Off</b>: hidden from agents, and Legion will not send its /command.
          </p>
          {!data.inherit ? (
            <p className="set-hint">
              Your Claude Code skills are not listed because “Inherit my Claude Code settings” is off.{' '}
              <button type="button" className="link-btn" onClick={() => setSettingsSection('claude')}>Open Claude settings</button>
            </p>
          ) : null}

          {searchable ? (
            <div className="house-search">
              <Icon name="search" size={14} />
              <input ref={searchBox} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={'Search by name, description or plugin…'} aria-label="Search skills" />
            </div>
          ) : null}
          {q ? (
            <p className="set-hint house-found" role="status" aria-live="polite">
              {found ? `${plural(found, 'match')} for “${q}”.` : `Nothing matches “${q}”.`}{' '}
              <button type="button" className="link-btn" onClick={() => { setQuery(''); searchBox.current?.focus(); }}>Clear search</button>
            </p>
          ) : emptyShown ? null : (
            <p className="set-hint arm-total">{totalLine(skills, filter, stateFilter, q, groups.flatMap((g) => g.skills))}</p>
          )}
          {q && stateFilter !== 'all' ? <p className="set-hint arm-total">{totalLine(skills, filter, stateFilter, q, groups.flatMap((g) => g.skills))}</p> : null}
          {total > 0 && !groups.length && !q && stateFilter !== 'all' ? (
            <p className="set-hint">Nothing here is {stateFilter === 'on' ? 'on' : 'set to only when you ask'}. <button type="button" className="link-btn" onClick={() => setStateFilter('all')}>Show all</button></p>
          ) : null}

          {emptyShown ? (
            <EmptyState filter={filter} none={!total} onNew={() => setEditor({ mode: 'new' })} onFile={() => fileInput.current?.click()} onFolder={() => dirInput.current?.click()} />
          ) : null}

          <div ref={wrap} className="arm-groups">
            {groups.map((g, i) => (
              <GroupCard key={g.key} g={g} open={narrowed || (open[g.key] ?? !g.collapsed) || g.skills.some((s) => s.id === highlight || s.id === reveal)} forced={narrowed}
                onToggle={(isOpen) => toggle(g, isOpen)} onKey={(e) => move(e, i)} agents={agents}
                onRead={(s) => void openRead(s.id, s.name)}
                onEdit={(s) => setEditor({ mode: 'edit', skill: s })}
                onAgents={(s) => setGrantFor(s.id)}
                onRemove={(s) => {
                  wantRemovedFocus.current?.done();
                  const intent = focusIntent((document.activeElement as HTMLElement | null)?.closest('li') ?? null);
                  wantRemovedFocus.current = intent;
                  void removeSkill(s.id).then((ok) => { if (!ok) { intent.done(); if (wantRemovedFocus.current === intent) wantRemovedFocus.current = null; } });
                }}
                onPromote={(s) => {
                  wantPromotedFocus.current?.done();
                  const intent = focusIntent((document.activeElement as HTMLElement | null)?.closest('li') ?? null);
                  wantPromotedFocus.current = intent;
                  void promoteSkill(s.id).then((ok) => { if (!ok) { intent.done(); if (wantPromotedFocus.current === intent) wantPromotedFocus.current = null; } });
                }} />
            ))}
          </div>

          <WhatAgentsSee agents={agents} />
          <Advanced />
          <SnackSlot onEl={setToastEl} />
        </>
      ) : null}

      <ReadDialog />
      {editor ? (
        <SkillEditor kind="skill" taken={takenNames}
          {...(editor.mode === 'edit' ? { edit: { name: editor.skill.name, loadText: () => readSkillText(editor.skill.id) } } : {})}
          onSave={async (f) => { const r = await saveSkill(f); savedRow.current = r.created ? r.id : null; }}
          onClose={() => {
            setEditor(null);
            // The button that opened the editor may be gone now (the empty state's), and the dialog hands focus back to a button that is not there:
            // a skill that was just created takes focus itself, once its row is drawn.
            const id = savedRow.current;
            savedRow.current = null;
            if (!id) return;
            const intent = focusIntent(rootEl.current);
            // One frame later, so the dialog has left the page and handed focus back first (to a button that may be gone): this has the last word.
            // If it is still there, focus on its Save button is not the owner going elsewhere.
            requestAnimationFrame(() => focusWhenReady({
              find: () => wrap.current?.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(id)}"]`) ?? null,
              fallback: () => heading.current, wanted: () => intent.still() || !!document.activeElement?.closest('.scrim'), done: () => intent.done(),
            }));
          }} />
      ) : null}
      {grantFor ? <AgentsDialog id={grantFor} agents={agents} onClose={() => setGrantFor(null)} /> : null}
      {picked ? <ImportDialog picked={picked.files} skipped={picked.skipped} onClose={() => setPicked(null)} /> : null}
    </div>
  );
}

/** "Listed from Claude Code 3 minutes ago" with Refresh, and a plain warning when Claude Code could not be asked. */
function Discovery({ data, nowMs, refreshing, error }: { data: ArmoryData; nowMs: number; refreshing: boolean; error: string | null }) {
  const line = discoveryLine(data, nowMs);
  const warn = discoveryWarning(data);
  if (!line) return null;
  return (
    <div className="arm-disc">
      <p className="set-hint arm-discline">
        <span>{line}</span>
        <button type="button" className="btn-ghost sm" aria-label="Refresh the list from Claude Code" aria-disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => { if (!refreshing) void refreshDiscovery(); }}>
          {refreshing ? <><span className="spin" /> Refreshing{'…'}</> : 'Refresh'}
        </button>
      </p>
      {warn ? <p className="arm-banner">{warn}</p> : null}
      {error ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`Could not refresh: ${error}`)} The list below is as it was.</span></p> : null}
    </div>
  );
}

/** Stays mounted while it works (aria-disabled, not disabled), so keyboard focus is not dropped by a try that fails again. */
function TryAgain({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  return (
    <button type="button" className="btn sm" aria-disabled={loading} aria-busy={loading || undefined} onClick={() => { if (!loading) onRetry(); }}>
      {loading ? <>Trying{'…'}</> : 'Try again'}
    </button>
  );
}

/** "Add from file ▾": the two ways to pick, as a menu. */
function AddMenu({ onFile, onFolder }: { onFile: () => void; onFolder: () => void }) {
  const items: MenuItem[] = [
    { key: 'file', label: 'A SKILL.md file', run: onFile },
    { key: 'folder', label: 'A skill folder', run: onFolder },
  ];
  return <RowMenu label="Add from file" items={items} trigger={{ className: 'btn sm', content: <>Add from file <Icon name="down" size={11} /></> }} />;
}

function EmptyState({ filter, none, onNew, onFile, onFolder }: { filter: ArmoryFilter; none: boolean; onNew: () => void; onFile: () => void; onFolder: () => void }) {
  return (
    <div className="arm-empty">
      <p>{none ? 'No skills yet.' : filter === 'imported' ? 'You have not added any skills from disk.' : 'You have not written any skills yet.'}</p>
      <p className="set-hint">Write one in the app, or add a SKILL.md file or a skill folder you already have.</p>
      <div className="arm-actions">
        <button type="button" className="btn sm primary" onClick={onNew}>New skill</button>
        <button type="button" className="btn sm" onClick={onFile}>Add a SKILL.md file</button>
        <button type="button" className="btn sm" onClick={onFolder}>Add a skill folder</button>
      </div>
    </div>
  );
}

/**
 * Focus after a change that makes the control you used disappear: it goes to Undo when Undo appears, and when Undo goes it goes
 * back to `fallback`, but only if focus was lost with it (never over a place the owner has already moved to).
 */
function useUndoFocus(active: boolean, undoBtn: React.RefObject<HTMLElement | null>, fallback: () => HTMLElement | null) {
  const want = useRef(false);
  const had = useRef(active);
  useEffect(() => {
    if (active && !had.current && want.current) { undoBtn.current?.focus(); want.current = false; }
    if (had.current && !active) {
      const lost = want.current || !document.activeElement || document.activeElement === document.body;
      if (lost) fallback()?.focus();
      want.current = false;
    }
    had.current = active;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return { expect: (): void => { want.current = true; } };
}

/** What Undo just did, in words that stay for a few seconds (a screen reader hears it too). */
function UndoneNote({ keyName }: { keyName: string }) {
  const u = useArmory((s) => (s.undone && s.undone.key === keyName ? s.undone : null));
  return u ? <span className="arm-undone" role="status">{u.message}</span> : null;
}

/** The step before a bulk change that would crowd an agent's prompt: what would happen, and Turn on or Cancel. Inline, not a dialog. */
function ConfirmStep({ message, title, onGo, onCancel, label }: { message: string; title: string; onGo: () => void; onCancel: () => void; label: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const textId = useId();
  // The step opens below the fold at times: focus without the browser's own jump, then bring the step into view the same way everywhere (nearest edge, padded clear of the snackbar).
  useEffect(() => { cancel.current?.focus({ preventScroll: true }); cancel.current?.closest('.arm-confirm')?.scrollIntoView?.({ block: 'nearest' }); }, []);
  return (
    <div className="arm-confirm" role="group" aria-label={`Confirm: ${title}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <span id={textId} className="arm-confirmtext">{message}</span>
      <button type="button" className="btn sm primary" aria-describedby={textId} onClick={onGo}>{label}</button>
      <button ref={cancel} type="button" className="btn sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** The one-time notice, and then (for a while) its Undo. */
function NoticeBar({ show, heading, toastEl }: { show: boolean; heading: React.RefObject<HTMLHeadingElement | null>; toastEl: HTMLElement | null }) {
  const busy = useArmory((s) => s.noticeBusy);
  const err = useArmory((s) => s.noticeError);
  const undo = useArmory((s) => (s.undo && s.undo.key === 'notice' ? s.undo : null));
  const resetting = useArmory((s) => s.resetting === 'notice');
  const n = useArmory((s) => turnAllOnTargets(s.data?.skills ?? []).length);
  const [confirm, setConfirm] = useState<BulkConsequence | null>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const turnBtn = useRef<HTMLButtonElement>(null);
  const focus = useUndoFocus(!!undo, undoBtn, () => turnBtn.current ?? heading.current);
  const was = useRef(false);
  useEffect(() => { if (was.current && !confirm) turnBtn.current?.focus(); was.current = !!confirm; }, [confirm]);
  const go = (): void => { setConfirm(null); focus.expect(); void turnAllOn(); };
  if (undo) {
    return (
      <Toast el={toastEl}>
        <div className="arm-bar" onMouseEnter={() => holdUndo('hover')} onMouseLeave={() => releaseUndo('hover')} onFocus={() => holdUndo('focus')} onBlur={() => releaseUndo('focus')}>
          <span className={undo.error ? 'house-undoerr' : undefined}>{undo.error ?? undo.message}</span>
          <button ref={undoBtn} type="button" className="btn sm" aria-disabled={resetting} aria-busy={resetting || undefined} onClick={() => { if (!resetting) void undoBulk(); }}>
            {resetting ? <>Undoing{'…'}</> : 'Undo'}
          </button>
        </div>
      </Toast>
    );
  }
  return (
    <>
      <UndoneNote keyName="notice" />
      {show ? (
        <section className="arm-notice" aria-label="Claude Code skills">
          <p>{NOTICE_TEXT}</p>
          {confirm ? (
            <ConfirmStep message={confirm.message} title="Turn all on" label="Turn on" onGo={go} onCancel={() => setConfirm(null)} />
          ) : (
            <div className="arm-noticebtns">
              {/* "Got it" is the safe choice, so it is the loud one; turning hundreds of skills on is the deliberate one. */}
              <button type="button" className="btn sm primary" aria-disabled={busy} onClick={() => { if (busy) return; focus.expect(); void dismissNotice().then((ok) => { if (ok) heading.current?.focus(); }); }}>Got it</button>
              <button ref={turnBtn} type="button" className="btn sm" aria-disabled={busy} aria-busy={busy || undefined}
                onClick={() => { if (busy) return; const c = consequenceOf('notice'); if (c.over) setConfirm(c); else go(); }}>
                {busy ? <>Working{'…'}</> : n > 0 ? `Turn all on (${n})` : 'Turn all on'}
              </button>
            </div>
          )}
          {err ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(err)} Try again.</span></p> : null}
        </section>
      ) : null}
    </>
  );
}

/** "Removed x. Undo": the skill is gone at once, and this brings it back. */
function RemovedBar({ wantFocus, heading, toastEl }: { wantFocus: React.MutableRefObject<FocusIntent | null>; heading: React.RefObject<HTMLHeadingElement | null>; toastEl: HTMLElement | null }) {
  const r = useArmory((s) => s.removed);
  const busy = useArmory((s) => !!s.removed && s.busyIds.includes(s.removed.id));
  const undoBtn = useRef<HTMLButtonElement>(null);
  const had = useRef(!!r);
  useEffect(() => {
    if (r && !had.current && wantFocus.current) {
      // Only if focus is still on the row it came from (or fell to the page) and no key was pressed since: never over what the owner is doing.
      if (wantFocus.current.still()) undoBtn.current?.focus();
      wantFocus.current.done();
      wantFocus.current = null;
    }
    if (had.current && !r) {
      // Gone because Undo worked: the restored row takes focus (the store asks for it, see focusRow). Gone for any other reason: the heading, unless focus is somewhere real.
      const a = document.activeElement;
      if ((!a || a === document.body) && !getArmory().focusRow) heading.current?.focus();
    }
    had.current = !!r;
  }, [r]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  return (
    <Toast el={toastEl}>
      <div className="arm-bar" onMouseEnter={() => holdRemoved('hover')} onMouseLeave={() => releaseRemoved('hover')} onFocus={() => holdRemoved('focus')} onBlur={() => releaseRemoved('focus')}>
        <span className={r.error ? 'house-undoerr' : undefined}>{r.error ?? `${r.message}${r.source === 'imported' ? ' Undo brings back SKILL.md only, and off.' : ''}`}</span>
        <button ref={undoBtn} type="button" className="btn sm" aria-disabled={busy} aria-busy={busy || undefined} onClick={() => { if (!busy) void undoRemove(); }}>
          {busy ? <>Undoing{'…'}</> : 'Undo'}
        </button>
        <button type="button" className="btn-ghost sm" onClick={() => { clearRemoved(); heading.current?.focus(); }}>Dismiss</button>
      </div>
    </Toast>
  );
}

function PromotedBar({ wantFocus, onOpen, toastEl }: { wantFocus: React.MutableRefObject<FocusIntent | null>; onOpen: () => void; toastEl: HTMLElement | null }) {
  const p = useArmory((s) => s.promoted);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p && wantFocus.current) { if (wantFocus.current.still()) open.current?.focus(); wantFocus.current.done(); wantFocus.current = null; }
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  return (
    <Toast el={toastEl}>
      <div className="arm-bar" role="status">
        <span>Copied {p.from} to Doctrine as the drill {p.name}. It is not approved and it is off. Approve it there before agents read it as a rule.</span>
        <button ref={open} type="button" className="btn sm" onClick={onOpen}>Open Doctrine</button>
        <button type="button" className="btn-ghost sm" onClick={dismissPromoted}>Dismiss</button>
      </div>
    </Toast>
  );
}

function GroupCard({ g, open, forced, onToggle, onKey, agents, onRead, onEdit, onAgents, onRemove, onPromote }: {
  g: ArmoryGroup; open: boolean; forced: boolean; onToggle: (isOpen: boolean) => void; onKey: (e: React.KeyboardEvent) => void; agents: readonly AgentRef[];
  onRead: (s: ArmorySkill) => void; onEdit: (s: ArmorySkill) => void; onAgents: (s: ArmorySkill) => void; onRemove: (s: ArmorySkill) => void; onPromote: (s: ArmorySkill) => void;
}) {
  const id = useId();
  const sumId = useId();
  const lockId = useId();
  const head = useRef<HTMLButtonElement>(null);
  const locked = g.kind === 'builtin' ? lockedNote(g.all) : '';
  return (
    <div className={`house-sg arm-group${open ? ' open' : ''}${forced ? ' forced' : ''}`}>
      <h4 className="house-sgh">
        <button ref={head} type="button" className="house-sgbtn" data-arm-gh aria-expanded={open} aria-controls={id} aria-disabled={forced || undefined}
          onClick={() => { if (!forced) onToggle(open); }} onKeyDown={onKey} aria-label={groupLabel(g, forced)} aria-describedby={sumId}>
          <Icon name="chevron" size={13} />
          <span className="house-sgtext">
            <span className="house-sgname">{g.title}</span>
            <span id={sumId} className="house-sgsum">{g.hint}</span>
          </span>
          <span className="house-sgcount">{g.countLine}{forced ? <span className="house-sgforced"> (showing matches)</span> : null}</span>
        </button>
      </h4>
      <div id={id} className="house-sgbody" hidden={!open}>
        {locked ? <p id={lockId} className="set-hint arm-locked"><Icon name="lock" size={12} /> <span>{locked}</span></p> : null}
        {forced ? null : <BulkTools g={g} fallback={() => head.current} />}
        {/* The rows of a closed group are not drawn at all: 374 skills cost nothing until a group is opened. */}
        {open ? (
          <ul className="house-list arm-list">
            {g.skills.map((s) => (
              <SkillRow key={s.id} s={s} g={g} agents={agents} lockId={lockId} onRead={onRead} onEdit={onEdit} onAgents={onAgents} onRemove={onRemove} onPromote={onPromote} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Turn the whole group on or off, at once, then say what it did, with Undo. The buttons say what they will do ("Turn on 12");
 * their accessible names add which group, so no two buttons share a name. With nothing to change a button is simply not there.
 * Focus: the button that was used may be gone after it runs, so focus moves to Undo; when Undo goes it returns to a button
 * of the group, or to the group's header.
 */
function BulkTools({ g, fallback }: { g: ArmoryGroup; fallback: () => HTMLElement | null }) {
  const nOn = useArmory(() => bulkCount(g.key, 'on'));
  const nOff = useArmory(() => bulkCount(g.key, 'off'));
  const busy = useArmory((s) => s.resetting === g.key);
  const other = useArmory((s) => s.resetting !== null && s.resetting !== g.key);
  const err = useArmory((s) => s.resetErrors[g.key]);
  const undo = useArmory((s) => (s.undo && s.undo.key === g.key ? s.undo : null));
  const undone = useArmory((s) => !!s.undone && s.undone.key === g.key);
  const [confirm, setConfirm] = useState<BulkConsequence | null>(null);
  const onBtn = useRef<HTMLButtonElement>(null);
  const offBtn = useRef<HTMLButtonElement>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const focus = useUndoFocus(!!undo, undoBtn, () => onBtn.current ?? offBtn.current ?? fallback());
  const was = useRef(false);
  useEffect(() => { if (was.current && !confirm) (onBtn.current ?? fallback())?.focus(); was.current = !!confirm; }, [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (to: 'on' | 'off'): void => { if (busy || other) return; setConfirm(null); focus.expect(); void bulkSet(g.key, to); };
  // Turning many on can crowd every agent's prompt: that is said first, with the number, and asked.
  const askOn = (): void => { if (busy || other) return; const c = consequenceOf(g.key); if (c.over) setConfirm(c); else run('on'); };
  if (!undo && !nOn && !nOff && !busy && !err && !undone) return null;
  return (
    <div className="house-sgtools">
      <div className="house-reset arm-bulk">
        {undo ? (
          <span className="house-undo" onMouseEnter={() => holdUndo('hover')} onMouseLeave={() => releaseUndo('hover')} onFocus={() => holdUndo('focus')} onBlur={() => releaseUndo('focus')}>
            <span className={undo.error ? 'house-undoerr' : undefined}>{undo.error ?? undo.message}</span>
            <button ref={undoBtn} type="button" className="btn sm" aria-disabled={busy} aria-busy={busy || undefined} onClick={() => { if (!busy) void undoBulk(); }}>
              {busy ? <>Undoing{'…'}</> : 'Undo'}
            </button>
          </span>
        ) : confirm ? (
          <ConfirmStep message={confirm.message} title={bulkName('on', nOn, g.title, g.key)} label={bulkLabel('on', nOn, g.key)} onGo={() => run('on')} onCancel={() => setConfirm(null)} />
        ) : (
          <>
            <UndoneNote keyName={g.key} />
            {nOn > 0 ? (
              <button ref={onBtn} type="button" className="btn-ghost sm" aria-disabled={busy || other} aria-label={bulkName('on', nOn, g.title, g.key)} onClick={askOn}>{bulkLabel('on', nOn, g.key)}</button>
            ) : null}
            {nOff > 0 ? (
              <button ref={offBtn} type="button" className="btn-ghost sm" aria-disabled={busy || other} aria-label={bulkName('off', nOff, g.title)} onClick={() => run('off')}>{bulkLabel('off', nOff)}</button>
            ) : null}
            {busy ? <span className="house-busy"><span className="spin" /> Working{'…'}</span> : null}
          </>
        )}
        {err ? <span className="house-rowerr" role="alert">{endSentence(`Could not change all of these: ${err}`)}</span> : null}
      </div>
    </div>
  );
}

const ROW_ERR: Record<string, string> = {
  state: 'Could not save',
  agents: 'Could not save the agent list',
  remove: 'Could not remove it',
  promote: 'Could not copy it to Doctrine',
};

function SkillRow({ s, g, agents, lockId, onRead, onEdit, onAgents, onRemove, onPromote }: {
  s: ArmorySkill; g: ArmoryGroup; agents: readonly AgentRef[]; lockId: string;
  onRead: (s: ArmorySkill) => void; onEdit: (s: ArmorySkill) => void; onAgents: (s: ArmorySkill) => void; onRemove: (s: ArmorySkill) => void; onPromote: (s: ArmorySkill) => void;
}) {
  const err = useArmory((st) => st.rowErrors[s.id]);
  const busy = useArmory((st) => st.busyIds.includes(s.id));
  const op = useArmory((st) => st.busyOps[s.id]);
  const fresh = useArmory((st) => st.highlight === s.id);
  const marked = useArmory((st) => st.reveal === s.id);
  const allowShell = useArmory((st) => st.data?.allowSkillShell === true);
  const savedOff = useArmory((st) => st.savedOff === s.id && s.state === 'off');
  const label = uniqueLabel(s);
  const li = useRef<HTMLLIElement>(null);
  useEffect(() => { if (fresh) li.current?.scrollIntoView?.({ block: 'nearest' }); }, [fresh]);
  const items: MenuItem[] = [{ key: 'read', label: 'Read', run: () => onRead(s) }];
  if (s.source === 'yours') items.push({ key: 'edit', label: 'Edit', run: () => onEdit(s) });
  if (s.path) items.push({ key: 'promote', label: 'Promote to drill', run: () => onPromote(s), busy });
  if (s.source === 'yours' || s.source === 'imported') items.push({ key: 'remove', label: 'Remove', run: () => onRemove(s), danger: true, busy });
  const grant = s.agents;
  const cmd = commandView(s);
  const tag = rowTag(s, g);
  return (
    <li ref={li} data-skill-id={s.id} tabIndex={-1} aria-busy={op === 'remove' || undefined} className={`house-row arm-row s-${s.state}${fresh ? ' is-new' : ''}${marked ? ' is-reveal' : ''}${op === 'remove' ? ' is-removing' : ''}`}>
      <div className="arm-line">
        <div className="arm-main">
          <div className="arm-titleline">
            <span className="arm-name">{s.name}</span>
            {cmd.runnable || cmd.note ? <code className={`arm-cmd${cmd.runnable ? '' : ' muted'}`}>{cmd.text}</code> : <span className="arm-cmd muted">{cmd.text}</span>}
            {cmd.note ? <span className="arm-cmdnote">{cmd.note}</span> : null}
            {tag ? <span className={`house-tag arm-src t-${s.source}`}>{tag}</span> : null}
            {s.fit === 'fit' ? <span className="house-tag arm-src t-fit">Useful for agents</span> : null}
            {s.offReason ? <span className="house-tag arm-src t-kept" aria-describedby={lockId}>{KEPT_OFF_TAG}</span> : null}
            {fresh ? <span className="house-tag arm-src t-new">New</span> : null}
            {op === 'remove' ? <span className="arm-removing"><span className="spin" /> Removing{'…'}</span> : null}
            {op === 'promote' ? <span className="arm-removing"><span className="spin" /> Copying{'…'}</span> : null}
          </div>
          <Description text={s.description || 'No description.'} name={label} />
          {savedOff ? (
            <p className="arm-saved" role="status">
              <span>Saved (off).</span>
              <button type="button" className="link-btn" aria-label={`Turn on ${label}`} onClick={() => { li.current?.focus(); void setSkillState(s.id, 'on'); }}>Turn on</button>
            </p>
          ) : null}
          {s.runsCommandsOnLoad ? <Note><strong>Runs commands when loaded.</strong> {runsNote(allowShell)}</Note> : null}
          {s.hiddenText ? <Note icon="eye"><strong>{HIDDEN_TEXT_FLAG}.</strong> {HIDDEN_TEXT_WHY}</Note> : null}
          {s.manualOnlyInFrontmatter && s.state === 'on' ? <Note icon="eye">Its own header says only on request, so agents will not open it on their own.</Note> : null}
        </div>
        <div className="arm-controls">
          <StateRadio skill={s} reasonId={s.offReason ? lockId : undefined} />
          {s.offReason ? null : (
            <button type="button" className="btn-ghost sm arm-agentsbtn" aria-haspopup="dialog" aria-label={agentsButtonName(label, grant, agents)} onClick={() => onAgents(s)}>
              Agents: {agentsLabel(grant, agents)} <Icon name="down" size={11} />
            </button>
          )}
          <RowMenu label={`More for ${label}`} items={items} />
        </div>
      </div>
      {err ? (
        <div className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`${ROW_ERR[err.op] ?? 'Could not save'}: ${err.message}`)}{err.op === 'state' ? ` It is still ${stateLabel(s.state).toLowerCase()}.` : ''}</span></div>
      ) : null}
    </li>
  );
}

/** What each agent sees, with the context cost. Loads when opened, and again (after a pause) when a skill changes. */
function WhatAgentsSee({ agents }: { agents: readonly AgentRef[] }) {
  const [open, setOpen] = useState(false);
  const hid = useId();
  const eff = useArmory((s) => s.effective);
  const sig = useArmory((s) => (s.data?.skills ?? []).map((k) => `${k.id}:${k.state}:${Array.isArray(k.agents) ? k.agents.join('+') : 'all'}`).join('|'));
  const key = agents.map((a) => a.id).join(',');
  const overList = agents.filter((a) => eff[a.id]?.data?.overBudget).map((a) => ({ name: a.name, total: eff[a.id]!.data!.counts.total }));
  const warnAbove = agents.map((a) => eff[a.id]?.data?.warnAbove).find((x) => typeof x === 'number') ?? 40;
  useEffect(() => {
    if (!open) return;
    // One request for every agent (the counts), not one each.
    const t = setTimeout(() => { void loadEffectiveAll(agents.map((a) => a.id)); }, 250);
    return () => clearTimeout(t);
  }, [open, sig, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="arm-see" aria-labelledby={`${hid}-h`}>
      <h4 id={`${hid}-h`} className="house-h arm-seeh">
        <button type="button" className="arm-seebtn" aria-expanded={open} aria-controls={hid} onClick={() => setOpen((o) => !o)}>
          <Icon name="chevron" size={13} /> What each agent sees <span className="house-hint">how many skill descriptions go into its prompt</span>
        </button>
      </h4>
      <div id={hid} hidden={!open}>
        {overList.length ? <p className="arm-warn" role="status"><Icon name="warn" size={12} /> {budgetSummary(overList, agents.length, warnAbove)}</p> : null}
        <ul className="arm-seelist">
          {agents.map((a) => {
            const slot = eff[a.id];
            const d = slot?.data;
            return (
              <li key={a.id} className="arm-seerow">
                <span className="arm-seename">{a.name}</span>
                <span className="arm-seetext">
                  {!slot || (slot.status === 'loading' && !d) ? <>Reading{'…'}</> : null}
                  {d ? seesText(d.counts) : null}
                  {slot?.status === 'error' ? (
                    <span className="house-undoerr" role="alert">{endSentence(`Could not read this: ${slot.error}`)} <button type="button" className="link-btn" onClick={() => void loadEffective(a.id)}>Try again</button></span>
                  ) : null}
                </span>
                <button type="button" className="link-btn arm-seelink" aria-label={`Choose skills for ${a.name}`} onClick={() => openEditor(a.id, 'skills')}>Choose skills</button>
              </li>
            );
          })}
          {!agents.length ? <li className="set-hint">No agents yet.</li> : null}
        </ul>
      </div>
    </section>
  );
}

/** The one switch that lets skills run commands the moment they load. Off, with a plain warning, unless the owner turns it on. */
function Advanced() {
  const on = useArmory((s) => s.data?.allowSkillShell === true);
  const busy = useArmory((s) => s.shellBusy);
  const err = useArmory((s) => s.shellError);
  const withLine = useArmory((s) => (s.data?.skills ?? []).filter((k) => k.runsCommandsOnLoad).length);
  const withLineOn = useArmory((s) => (s.data?.skills ?? []).filter((k) => k.runsCommandsOnLoad && k.state !== 'off').length);
  const [ask, setAsk] = useState(false);
  const warnId = useId();
  const sw = useRef<HTMLInputElement>(null);
  const was = useRef(false);
  // The switch gets focus back when the step closes, whichever way it closed.
  useEffect(() => { if (was.current && !ask) sw.current?.focus(); was.current = ask; }, [ask]);
  return (
    <section className="arm-adv" aria-label="Advanced">
      <h4 className="house-h">Advanced</h4>
      <div className="arm-advrow">
        <label className={`house-sw warn${busy ? ' busy' : ''}`}>
          {/* Off to on is asked first (what changes, how many skills it reaches). On to off is the safe direction and is not asked. */}
          <input ref={sw} type="checkbox" role="switch" checked={on} aria-disabled={busy || undefined} aria-describedby={warnId}
            aria-label="Let skills run commands when they load" onChange={(e) => { if (busy) return; if (e.target.checked) setAsk(true); else void setAllowShell(false); }} />
          <span className="house-swtrack" aria-hidden="true"><i /></span>
          <span className="house-swtext">{on ? 'On' : 'Off'}</span>
        </label>
        <div className="arm-advtext">
          <p className="arm-advlabel">Let skills run commands when they load</p>
          <p id={warnId} className="set-hint">{SHELL_WARNING} {SHELL_SCOPE}</p>
        </div>
      </div>
      {ask ? <ConfirmStep message={shellConfirm(withLine, withLineOn)} title="Let skills run commands when they load" label="Turn on" onGo={() => { setAsk(false); void setAllowShell(true); }} onCancel={() => setAsk(false)} /> : null}
      {on ? <p className="arm-shellon"><Icon name="warn" size={12} /> <span>{SHELL_ON_LINE}</span></p> : null}
      {err ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`Could not save: ${err}`)} The switch is still {on ? 'on' : 'off'}.</span></p> : null}
    </section>
  );
}
