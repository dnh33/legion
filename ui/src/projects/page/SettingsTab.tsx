/**
 * The project Settings tab (spec 3.6): a section nav with a scroll-spy and a dot for "changed from the default", then General, Folders,
 * Members (moved from the old page, same native confirmations), While you are away, Safety, Budget, Notifications and Archive.
 * What each input accepts and what the form may offer lives in settingsLogic.ts. Nothing here allows an ask: the reads grant is a gate
 * rule created only after Confirm.
 */
import { useEffect, useRef, useState } from 'react';
import { PROJECT_LIMITS } from '../../../../src/shared/projects';
import type { Project } from '../../../../src/shared/projects';
import { loadSettings, useStore } from '../../store';
import { archiveProject, changeMembers, chooseFolder, saveProject, unarchiveProject, useDefaultFolder } from '../projectsStore';
import { followRemote, instructionsCounter } from '../projectsLogic';
import { loadMarshal, saveMarshal, useBoard } from '../board/boardStore';
import { patchAway, projectAway, setPaused, useAway } from '../awayStore';
import { announce } from './announce';
import { grantReads, revokeReads } from './readsGrant';
import { BUDGET_ERROR, PARK_ERROR, SETTINGS_NAV, awayFormModel, budgetPatch, changedSections, findReadsGrant, parseBudget, parseParkMinutes } from './settingsLogic';
import type { Period } from './settingsLogic';
import type { PageFacts } from './pageLogic';
import { PIcon } from './PIcon';
import '../projects.css';
import './settings.css';

function Switch({ on, label, disabled, onChange, id }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void; id: string }) {
  return <button type="button" role="switch" id={id} className="pg-sw" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

function Opt({ id, title, help, children }: { id: string; title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="pg-opt">
      <div><b id={`${id}-l`}>{title}</b>{help && <span className="h" id={`${id}-h`}>{help}</span>}</div>
      <div className="ctl">{children}</div>
    </div>
  );
}

export function SettingsTab({ f, project }: { f: PageFacts; project: Project }) {
  const [active, setActive] = useState('general');
  const root = useRef<HTMLDivElement>(null);
  const away = useAway((s) => projectAway(s, project.id));
  const changed = changedSections(away);
  const archived = project.status === 'archived';

  // scroll-spy: the section nearest the top of the page's scroll area is the current one
  useEffect(() => {
    const scroller = document.getElementById('pg-panel');
    const secs = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-sec]') ?? []);
    if (!scroller || !secs.length) return;
    const on = (): void => {
      const top = scroller.getBoundingClientRect().top + 24;
      let cur = secs[0]!.dataset.sec!;
      for (const s of secs) if (s.getBoundingClientRect().top <= top) cur = s.dataset.sec!;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = secs[secs.length - 1]!.dataset.sec!;
      setActive(cur);
    };
    scroller.addEventListener('scroll', on, { passive: true });
    on();
    return () => scroller.removeEventListener('scroll', on);
  }, []);
  const go = (id: string): void => {
    const el = root.current?.querySelector<HTMLElement>(`[data-sec="${id}"]`);
    el?.scrollIntoView({ block: 'start' });
    setActive(id);
    el?.querySelector<HTMLElement>('h2')?.focus();
  };

  return (
    <div className="pg-inner pg-set2" ref={root}>
      <nav className="pg-snav" aria-label="Settings sections">
        {SETTINGS_NAV.map((n) => {
          const dot = n.changed ? changed.has(n.changed) : false;
          return (
            <button key={n.id} type="button" aria-current={active === n.id ? 'true' : undefined} className={active === n.id ? 'on' : ''} onClick={() => go(n.id)}>
              {n.label}{dot && <><i className="dt" aria-hidden="true" /><span className="sr">, changed from the default</span></>}
            </button>
          );
        })}
        <span className="leg"><i aria-hidden="true" />Changed from the default</span>
      </nav>
      <div className="pg-sbody">
        <General project={project} />
        <Folders project={project} />
        <Members project={project} f={f} />
        <Away project={project} />
        <Safety project={project} />
        <BudgetSection project={project} />
        <Notify project={project} />
        <section data-sec="archive" aria-labelledby="set-h-archive">
          <h2 id="set-h-archive" tabIndex={-1}><PIcon name="archive" size={15} />Archive</h2>
          <p className="lead">{archived ? 'This project is archived. It starts no new tasks and its board is read-only. Nothing was deleted.' : 'An archived project starts no new tasks and its board is read-only. Nothing is deleted, and you can unarchive it.'}</p>
          <button type="button" className="pg-btn" onClick={() => { void (archived ? unarchiveProject(project) : archiveProject(project)); }}>{archived ? 'Unarchive project' : 'Archive project'}</button>
        </section>
      </div>
    </div>
  );
}

/* ---------- General, Folders, Members (moved from the old page) ---------- */
function General({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [text, setText] = useState(project.instructions);
  const [busy, setBusy] = useState(false);
  const prev = useRef(project);
  useEffect(() => {
    setName((n) => (!n.trim() ? project.name : followRemote(n, prev.current.name, project.name)));
    setText((t) => followRemote(t, prev.current.instructions, project.instructions));
    prev.current = project;
  }, [project.name, project.instructions]); // eslint-disable-line react-hooks/exhaustive-deps
  const counter = instructionsCounter(text);
  const nameDirty = name.trim() !== project.name;
  const textDirty = text.slice(0, PROJECT_LIMITS.instructionsChars) !== project.instructions;
  return (
    <section data-sec="general" aria-labelledby="set-h-general">
      <h2 id="set-h-general" tabIndex={-1}>General</h2>
      <p className="lead">The instructions are added to every task here, after the agent&rsquo;s own, and labelled as the project&rsquo;s. They are context only: they cannot change what an agent is allowed to do.</p>
      <form className="pg-form" onSubmit={(e) => { e.preventDefault(); setBusy(true); void saveProject(project.id, { ...(nameDirty ? { name: name.trim() } : {}), ...(textDirty ? { instructions: text } : {}) }).finally(() => setBusy(false)); }}>
        <label>Name<input id="pg-name" className="pg-inp" value={name} maxLength={PROJECT_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} /></label>
        <label>Instructions
          <textarea className="pg-inp" rows={7} value={text} aria-describedby="proj-count" onChange={(e) => setText(e.target.value)} />
          <span id="proj-count" className={'cnt' + (counter.over ? ' over' : '')}>{counter.label}</span>
        </label>
        <div><button type="submit" className="pg-btn" disabled={busy || !name.trim() || (!nameDirty && !textDirty)}>Save</button></div>
      </form>
    </section>
  );
}

function Folders({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <section data-sec="folders" aria-labelledby="set-h-folders">
      <h2 id="set-h-folders" tabIndex={-1}>Folders</h2>
      <p className="lead">Members can read and write files here when they work on this project&rsquo;s tasks. Changing it shows a confirmation in a separate window.</p>
      <p className="pg-path"><code>{project.folder}</code></p>
      <div className="pg-row2">
        <button type="button" className="pg-btn" disabled={busy} onClick={() => void run(() => chooseFolder(project.id))}>Choose folder&hellip;</button>
        <button type="button" className="pg-btn ghost" disabled={busy} onClick={() => void run(() => useDefaultFolder(project.id))}>Use default folder</button>
      </div>
    </section>
  );
}

function Members({ project, f }: { project: Project; f: PageFacts }) {
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<void> => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const members = project.members.map((id) => f.agents.find((a) => a.id === id) ?? { id, name: id, emoji: '?' }) as Array<{ id: string; name: string; emoji?: string }>;
  const outside = f.agents.filter((a) => !project.members.includes(a.id));
  return (
    <section data-sec="members" aria-labelledby="set-h-members">
      <h2 id="set-h-members" tabIndex={-1}>Members</h2>
      <p className="lead">Adding or removing a member shows a confirmation in a separate window.</p>
      {members.length === 0 ? <p className="lead">No members yet.</p> : (
        <ul className="pg-chips2">
          {members.map((a) => (
            <li key={a.id} className="pg-chip2"><span>{a.emoji} {a.name}</span>
              <button type="button" className="x" disabled={busy} aria-label={'Remove ' + a.name + ' from this project'} onClick={() => void run(() => changeMembers(project.id, project.members.filter((m) => m !== a.id)))}><PIcon name="close" size={12} /></button>
            </li>
          ))}
        </ul>
      )}
      {outside.length > 0 && (
        <div className="pg-row2">
          <label className="pg-inline"><span>Add an agent</span>
            <select className="pg-inp sel" value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">Choose an agent</option>
              {outside.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
            </select>
          </label>
          <button type="button" className="pg-btn" disabled={busy || !add || members.length >= PROJECT_LIMITS.members} onClick={() => void run(async () => { if (await changeMembers(project.id, [...project.members, add])) setAdd(''); })}>Add</button>
        </div>
      )}
    </section>
  );
}

/* ---------- While you are away ---------- */
function Away({ project }: { project: Project }) {
  const pid = project.id;
  const away = useAway((s) => projectAway(s, pid));
  const caps = useStore((s) => s.caps);
  const enabled = useBoard((s) => s.enabled);
  const marshal = useBoard((s) => s.statuses[pid]);
  const m = awayFormModel(caps, away.onSilence.mode);
  const [mins, setMins] = useState(String(away.onSilence.parkMinutes));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setMins(String(away.onSilence.parkMinutes)); setErr(null); }, [away.onSilence.parkMinutes]);
  useEffect(() => { if (enabled === 'yes') void loadMarshal(pid); }, [enabled, pid]);
  const setMode = (mode: 'deny' | 'park'): void => {
    if (mode === 'deny') { void patchAway(pid, { onSilence: { mode: 'deny', parkMinutes: away.onSilence.parkMinutes } }); return; }
    const p = parseParkMinutes(mins);
    if (!p.ok) { setErr(p.error); return; }
    void patchAway(pid, { onSilence: { mode: 'park', parkMinutes: p.value } });
  };
  const commitMins = (): void => {
    const p = parseParkMinutes(mins);
    if (!p.ok) { setErr(p.error); return; }
    setErr(null);
    if (m.shownMode === 'park' && p.value !== away.onSilence.parkMinutes) void patchAway(pid, { onSilence: { mode: 'park', parkMinutes: p.value } });
  };
  const marshalOn = marshal?.marshal.enabled === true;
  return (
    <section data-sec="away" aria-labelledby="set-h-away">
      <h2 id="set-h-away" tabIndex={-1}>While you are away{changedSections(away).has('away') && <span className="changed">Changed</span>}</h2>
      <p className="lead">Runs keep going without you. When one needs you, it waits for your answer.</p>
      <div className="pg-opt" role="radiogroup" aria-labelledby="away-silence-l">
        <div>
          <b id="away-silence-l">When nobody answers</b>
          <span className="h">{m.shownMode === 'park' ? `After ${away.onSilence.parkMinutes} min a waiting run stops and keeps its work.` : 'An ask that waits 10 min is denied, and the agent is told. Nothing is ever allowed by waiting.'}</span>
        </div>
        <div className="ctl col">
          <label className="pg-radio"><input type="radio" name="silence" checked={m.shownMode === 'deny'} onChange={() => setMode('deny')} /><span>Wait 10 min, then deny</span><span className="pg-tag">Default</span></label>
          {m.silenceModes.includes('park') && (
            <>
              <label className="pg-radio"><input type="radio" name="silence" checked={m.shownMode === 'park'} onChange={() => setMode('park')} /><span>Park the run after</span>
                <input className="pg-inp num-in" inputMode="numeric" aria-label="Minutes before the run parks" aria-invalid={!!err} aria-describedby={err ? 'park-err' : undefined} value={mins}
                  onChange={(e) => { setMins(e.target.value); setErr(null); }} onBlur={commitMins} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitMins(); } }} />
                <span>min</span></label>
              {err && <div id="park-err" className="ferr" role="alert">{err || PARK_ERROR}</div>}
              <span className="h">Parked: the run stops and keeps its work. Answer it to pick up where it stopped.</span>
            </>
          )}
        </div>
      </div>
      <Opt id="away-pause" title="Pause new starts" help="Tasks you start yourself still run. Board items and Marshal starts wait until you resume.">
        <Switch id="away-pause-sw" on={away.paused} label="Pause new starts" onChange={(v) => { void setPaused(pid, v).then((ok) => { if (ok) announce(v ? 'New starts are paused.' : 'New starts resumed.'); }); }} />
      </Opt>
      {enabled === 'yes' && marshal && (
        <Opt id="away-marshal" title="Let the Marshal start board items" help="It starts items in Doing with the assigned agent.">
          <Switch id="away-marshal-sw" on={marshalOn} label="Let the Marshal start board items" onChange={(v) => { void saveMarshal(pid, { ...marshal.marshal, enabled: v }).then((r) => { if (r) announce(v ? 'The Marshal starts board items.' : 'The Marshal no longer starts board items.'); }); }} />
        </Opt>
      )}
      {m.keepAwake && (
        <Opt id="away-awake" title="Keep your computer awake while work runs" help="Only while a run is active in this project. Your screen can still turn off.">
          <Switch id="away-awake-sw" on={false} label="Keep your computer awake while work runs" onChange={() => undefined} />
        </Opt>
      )}
    </section>
  );
}

/* ---------- Safety: the reads grant ---------- */
function Safety({ project }: { project: Project }) {
  const settings = useStore((s) => s.settings);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!settings) void loadSettings(); }, [settings]);
  const granted = !!findReadsGrant(settings?.gates?.rules ?? [], project);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) confirmBtn.current?.focus(); }, [confirming]);
  return (
    <section data-sec="safety" aria-labelledby="set-h-safety">
      <h2 id="set-h-safety" tabIndex={-1}>Safety</h2>
      <p className="lead">These options mean fewer approvals. Writes and commands always ask.</p>
      <Opt id="safe-reads" title="Let agents read files in this project without asking" help="Reads inside the project folders stop asking. Writes and commands still ask.">
        <Switch id="safe-reads-sw" on={granted || confirming} label="Let agents read files in this project without asking" disabled={busy} onChange={(v) => {
          if (v) { setConfirming(true); return; }
          setConfirming(false);
          if (granted) { setBusy(true); void revokeReads(project).then((ok) => { setBusy(false); if (ok) announce('Reads ask again in this project.'); }); }
        }} />
      </Opt>
      {confirming && !granted && (
        <div className="pg-sh-conf pg-confirm" role="group" aria-label="Stop asking for reads in this project?" data-testid="reads-confirm">
          <b>Stop asking for reads in this project?</b>
          <p>Agents will read files in this project without asking. Writes and commands still ask. You can turn this off here at any time.</p>
          <div className="row">
            <button ref={confirmBtn} type="button" className="pg-btn strong" disabled={busy} onClick={() => { setBusy(true); void grantReads(project).then((ok) => { setBusy(false); if (ok) { setConfirming(false); announce('Done. Agents read files in this project without asking.'); } }); }}>Confirm</button>
            <button type="button" className="pg-btn ghost" onClick={() => { setConfirming(false); document.getElementById('safe-reads-sw')?.focus(); }}>Not now</button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- Budget ---------- */
function BudgetSection({ project }: { project: Project }) {
  const pid = project.id;
  const away = useAway((s) => projectAway(s, pid));
  const b = away.budget;
  const [amount, setAmount] = useState(b ? String(b.limit) : '50');
  const [period, setPeriod] = useState<Period>(b?.period ?? 'week');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (b) { setAmount(String(b.limit)); setPeriod(b.period); } }, [b?.limit, b?.period]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = parseBudget(amount);
  const dirty = !!b && (period !== b.period || (p.ok && p.value !== b.limit));
  const save = (on: boolean): void => {
    if (!on) { void patchAway(pid, budgetPatch(false, 0, period)).then((ok) => { if (ok) announce('The budget is off.'); }); return; }
    if (!p.ok) { setErr(p.error || BUDGET_ERROR); return; }
    setErr(null);
    void patchAway(pid, budgetPatch(true, p.value, period)).then((ok) => { if (ok) announce('Budget saved.'); });
  };
  const noun = period === 'day' ? 'daily' : period === 'month' ? 'monthly' : 'weekly';
  return (
    <section data-sec="budget" aria-labelledby="set-h-budget">
      <h2 id="set-h-budget" tabIndex={-1}>Budget{changedSections(away).has('budget') && <span className="changed">Changed</span>}</h2>
      <p className="lead">At the budget, new runs wait, running work finishes, and you get one notification.</p>
      <Opt id="bud" title={`Set a ${noun} budget`} help={b ? undefined : 'No budget. Optional.'}>
        <Switch id="bud-sw" on={!!b} label={`Set a ${noun} budget`} onChange={save} />
      </Opt>
      {b && (
        <div className="pg-sub-opts">
          <label className="pg-inline">$ <input className="pg-inp num-in wide" inputMode="decimal" aria-label="Budget in dollars" aria-invalid={!!err || !p.ok} aria-describedby={err ? 'bud-err' : undefined} value={amount} onChange={(e) => { setAmount(e.target.value); setErr(null); }} /></label>
          <span className="pg-seg" role="radiogroup" aria-label="Budget period">
            {(['day', 'week', 'month'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={period === k} onClick={() => setPeriod(k)}>{k === 'day' ? 'Day' : k === 'week' ? 'Week' : 'Month'}</button>)}
          </span>
          {dirty && <button type="button" className="pg-btn" onClick={() => save(true)}>Save budget</button>}
          {err && <div id="bud-err" className="ferr" role="alert">{err}</div>}
        </div>
      )}
    </section>
  );
}

/* ---------- Notifications ---------- */
const LEVELS: ReadonlyArray<{ id: 'problems' | 'everything' | 'nothing'; label: string }> = [
  { id: 'problems', label: 'Needs you and problems' }, { id: 'everything', label: 'Everything' }, { id: 'nothing', label: 'Nothing' },
];
function Notify({ project }: { project: Project }) {
  const away = useAway((s) => projectAway(s, project.id));
  return (
    <section data-sec="notify" aria-labelledby="set-h-notify">
      <h2 id="set-h-notify" tabIndex={-1}>Notifications{changedSections(away).has('notify') && <span className="changed">Changed</span>}</h2>
      <p className="lead">You hear about what needs you and what failed. Quiet hours are in app Settings.</p>
      <div className="pg-opt" role="radiogroup" aria-label="What you hear about from this project">
        <div className="ctl col start">
          {LEVELS.map((l) => (
            <label key={l.id} className="pg-radio"><input type="radio" name="notify" checked={away.notify === l.id} onChange={() => { void patchAway(project.id, { notify: l.id }); }} /><span>{l.label}</span>{l.id === 'problems' && <span className="pg-tag">Default</span>}</label>
          ))}
        </div>
      </div>
    </section>
  );
}
