/**
 * Settings → Doctrine: which rule and skill files agents are served, and the one place a file becomes a rule.
 *
 * Two separate decisions live here and must not blur:
 *  - the SWITCH says whether agents are served a file at all (a serving filter; the file stays on disk);
 *  - the TRUST tag and the Approve button say how agents read it once served. A file the owner wrote is NOT trusted, and
 *    never becomes so by itself: it needs one click here, and one click again after every edit, because the approval is
 *    a hash of specific bytes (ADR 0010). A standing "trust this path forever" grant would be the hole the module exists
 *    to avoid -- an agent runs as the same OS user and could edit the file after the click.
 *
 * Grouping, order, labels and counts come from src/shared/house-view.ts (pure, tested). This file only draws them.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { openExternal } from '../api';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import {
  closeHouseFile, getHouse, holdUndo, loadHouse, loadLicenceNames, openHouseFile, releaseUndo, resetCount, resetHouse, resetKey, retryLoad,
  setHouseSwitch, setHouseTrust, undoBulk, useHouse,
} from './houseStore';
import type { HouseFileView, ResetScope } from './houseStore';
import {
  bulkLabel, bulkName, bulkNothing, buildView, displayTitle, dropLeadingTitle, endSentence, formatBytes, humaniseSkillName, LICENCE_RE, licenceLabels,
  LOCK_REASON, matchCount, missingLine, nextHeader, noSkillsShipped, parseOpenGroups, parseSkillText, pathIsRedundant, plural, showSearch,
  SKILLS_BANNER, skillGroupLabel, TRUST_LEGEND, trustBlurb, trustLabel,
} from '../../../src/shared/house-view';
import type { GroupView, SkillGroupView } from '../../../src/shared/house-view';
import './house.css';

const OPEN_KEY = 'legion.house.skillGroupsOpen';

export function HouseSection() {
  const st = useHouse((s) => s.status);
  const loaded = useHouse((s) => s.loaded);
  const loadError = useHouse((s) => s.loadError);
  const loading = useHouse((s) => s.loading);
  const absent = useHouse((s) => s.absent);
  const notice = useHouse((s) => s.notice);
  const licenceNames = useHouse((s) => s.licenceNames);
  const [query, setQuery] = useState('');
  const searchBox = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retried = useRef(false);

  // Re-read on entry: the owner may have edited files in this folder since it was last open.
  useEffect(() => { void loadHouse(); }, []);
  // A Try again that worked removes its own button, so focus would fall to the page. It goes to the heading instead.
  useEffect(() => {
    if (retried.current && loaded && !loadError) { retried.current = false; heading.current?.focus(); }
  }, [loaded, loadError]);

  const files = st?.files ?? [];
  const searchable = showSearch(files);
  // Only real words count: a query of spaces is no query (no "0 matches", no hidden actions, no forced-open groups).
  const q = searchable ? query.trim() : '';
  const groups = useMemo(() => buildView(files, q, licenceNames), [files, q, licenceNames]);
  // The Licence buttons say which licence ("MIT") and search finds it, so each licence file is read once.
  const licencePaths = useMemo(
    () => files.filter((f) => f.category === 'skills' && !!f.skill && f.skill !== f.path && LICENCE_RE.test(f.path.split('/').pop() ?? '')).map((f) => f.path),
    [files],
  );
  useEffect(() => { if (licencePaths.length) void loadLicenceNames(licencePaths); }, [licencePaths]);
  const retry = (): void => { retried.current = true; void retryLoad(); };

  if (absent) {
    return (
      <div className="set-section">
        <header className="set-head"><h3 ref={heading} tabIndex={-1}>Doctrine</h3><p>This version of Legion has no doctrine screen. Update to get it.</p></header>
      </div>
    );
  }
  if (loadError && !loaded) {
    return (
      <div className="set-section">
        <header className="set-head"><h3 ref={heading} tabIndex={-1}>Doctrine</h3></header>
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`Could not read your doctrine files: ${loadError}`)}</span>
          <TryAgain loading={loading} onRetry={retry} />
        </div>
      </div>
    );
  }

  const count = matchCount(groups);
  return (
    <div className="set-section house-cq">
      <header className="set-head">
        <h3 ref={heading} tabIndex={-1}>Doctrine</h3>
        <p>
          The rules and skills your agents follow. Agents read these rules before they start work. Skills are different:
          an agent opens one only when its job calls for it. A switch decides whether agents see a file. Trust is separate:
          a file you write needs your approval to count as a rule, and needs it again after any edit, because approval
          covers those exact words.
        </p>
      </header>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{notice}</div>

      {loadError && loaded ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`This list may be out of date: ${loadError}`)}</span>
          <TryAgain loading={loading} onRetry={retry} />
        </div>
      ) : null}

      {(st?.missing.length ?? 0) > 0 ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} />
          <span>{missingLine(st!.missing)}</span>
        </div>
      ) : null}

      {!loaded ? <div className="set-loading"><span className="spin" /> Reading your doctrine files{'…'}</div> : null}

      {loaded && !files.length ? (
        <p className="set-hint">
          No doctrine files yet. Put a markdown file in <code>{st?.root}</code> and it will appear here, not yet approved,
          ready for you to make it a rule.
        </p>
      ) : null}

      {loaded && files.length ? <p className="set-hint house-legend">{TRUST_LEGEND}</p> : null}

      {loaded && searchable ? (
        <div className="house-search">
          <Icon name="search" size={14} />
          <input ref={searchBox} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={'Search by title, file name or description…'} aria-label="Search doctrine files" />
        </div>
      ) : null}
      {q ? (
        <p className="set-hint house-found" role="status" aria-live="polite">
          {count ? `${plural(count, 'match')} for “${q.trim()}”.` : `Nothing matches “${q.trim()}”.`}
          {' '}
          <button type="button" className="link-btn" onClick={() => { setQuery(''); searchBox.current?.focus(); }}>Clear search</button>
        </p>
      ) : null}

      {groups.map((g) => <Group key={g.info.category} g={g} files={files} searching={!!q} />)}

      <ReadDialog />
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

function Group({ g, files, searching }: { g: GroupView; files: HouseFileView[]; searching: boolean }) {
  const hid = useId();
  const cat = g.info.category;
  const head = useRef<HTMLHeadingElement>(null);
  const hasBulk = !g.locked && !searching && !(cat === 'skills' && noSkillsShipped(files));
  return (
    <section className="house-group" aria-labelledby={hid}>
      <div className="house-ghead">
        <div className="house-gtext">
          <h4 id={hid} ref={head} tabIndex={-1} className="house-h">{g.info.title} <span className="house-hint">{g.info.hint}</span> <span className="house-count">{g.countLine}</span></h4>
          <p className="set-hint">{g.info.blurb}</p>
        </div>
        {hasBulk ? <BulkAction scope={{ category: cat }} title={g.info.title} fallback={() => head.current} /> : null}
      </div>

      {cat === 'skills' ? <SkillsBody g={g} files={files} searching={searching} /> : (
        <ul className="house-list">
          {g.rows.map((f) => <Row key={f.path} f={f} />)}
        </ul>
      )}
    </section>
  );
}

/**
 * The one pattern for every bulk change: it runs at once, then says what it did, with Undo. The button says what it will
 * do ("Turn off 2", "Turn 2 back on"); its accessible name adds which group, so no two buttons share a name. With
 * nothing to change, a short reason takes its place (skills say nothing: the header already reads "0 of 4 on").
 *
 * The Undo offer waits while the pointer or focus is on it, and says when it is gone (see the store). A failed Undo keeps
 * the offer, with the reason and Try again, and focus stays on its button.
 *
 * Focus: the bulk button is usually gone after it runs, so focus moves to Undo; when Undo goes (used, or timed out) focus
 * goes back to the button, or to `fallback` (the group's heading or header) if the button is gone too.
 */
function BulkAction({ scope, title, fallback }: { scope: ResetScope; title: string; fallback: () => HTMLElement | null }) {
  const key = resetKey(scope);
  const n = useHouse(() => resetCount(scope));
  const busy = useHouse((s) => s.resetting === key);
  const other = useHouse((s) => s.resetting !== null && s.resetting !== key);
  const err = useHouse((s) => s.resetErrors[key]);
  const undo = useHouse((s) => (s.undo && s.undo.key === key ? s.undo : null));
  const btn = useRef<HTMLButtonElement>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const want = useRef<'undo' | 'button' | null>(null);
  const undoFocused = useRef(false);
  const prev = useRef(undo);
  const nothing = bulkNothing(scope);
  useEffect(() => {
    if (undo && !prev.current && want.current === 'undo') { undoBtn.current?.focus(); want.current = null; }
    if (prev.current && !undo) {
      const lost = want.current === 'button' || (undoFocused.current && (!document.activeElement || document.activeElement === document.body));
      if (lost) (btn.current ?? fallback())?.focus();
      want.current = null;
      undoFocused.current = false;
    }
    prev.current = undo;
  }, [undo]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="house-reset">
      {undo ? (
        <span className="house-undo" onMouseEnter={() => holdUndo('hover')} onMouseLeave={() => releaseUndo('hover')}
          onFocus={() => { undoFocused.current = true; holdUndo('focus'); }}
          onBlur={(e) => { if (e.relatedTarget) undoFocused.current = false; releaseUndo('focus'); }}>
          <span className={undo.error ? 'house-undoerr' : undefined}>{undo.error ?? undo.message}</span>
          <button ref={undoBtn} type="button" className="btn sm" aria-disabled={busy} aria-busy={busy || undefined}
            onClick={async () => {
              if (busy) return;
              want.current = 'button';
              await undoBulk();
              // The offer is still here: that Undo failed. Focus never left the button, so nothing is to be given back.
              if (getHouse().undo) want.current = null;
            }}>
            {busy ? <>Undoing{'…'}</> : 'Undo'}
          </button>
        </span>
      ) : n > 0 ? (
        <>
          <button ref={btn} type="button" className="btn-ghost sm" aria-disabled={busy || other} aria-label={bulkName(scope, n, title)}
            onClick={() => { if (busy || other) return; want.current = 'undo'; void resetHouse(scope); }}>
            {bulkLabel(scope, n)}
          </button>
          {busy ? <span className="house-busy"><span className="spin" /> Working{'…'}</span> : null}
        </>
      ) : busy || nothing ? <span className="house-none">{busy ? <>Working{'…'}</> : nothing}</span> : null}
      {err ? <span className="house-rowerr" role="alert">{endSentence(`Could not change these switches: ${err}`)}</span> : null}
    </div>
  );
}

function SkillsBody({ g, files, searching }: { g: GroupView; files: HouseFileView[]; searching: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return parseOpenGroups(window.localStorage.getItem(OPEN_KEY)); } catch { return {}; }
  });
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = (key: string): void => {
    const next = { ...open, [key]: !open[key] };
    if (!next[key]) delete next[key];
    setOpen(next);
    try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* works without storage */ }
  };
  const move = (e: React.KeyboardEvent, i: number): void => {
    const heads = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[data-house-gh]') ?? []);
    const to = nextHeader(e.key, i, heads.length);
    if (to === null) return;
    e.preventDefault();
    heads[to]?.focus();
  };

  if (noSkillsShipped(files)) {
    return <p className="set-hint house-empty">This version of Legion ships no skills.</p>;
  }
  return (
    <>
      <p className="house-banner" role="note">{SKILLS_BANNER}</p>
      <div ref={wrap} className="house-skillgroups">
        {g.skillGroups.map((sg, i) => (
          <SkillGroup key={sg.key} sg={sg} open={searching || !!open[sg.key]} forced={searching} onToggle={() => toggle(sg.key)} onKey={(e) => move(e, i)} />
        ))}
      </div>
      {g.about.length ? (
        <p className="set-hint house-about">
          About these skills:{' '}
          {g.about.map((f, i) => {
            const sources = f.path.toLowerCase().endsWith('sources.md');
            return (
              <span key={f.path}>{i ? ' · ' : ''}
                <button type="button" className="link-btn" onClick={() => void openHouseFile(f.path, sources ? 'Where the skills come from' : 'About these skills')}>
                  {sources ? 'sources and licences' : 'read me'}
                </button>
              </span>
            );
          })}
        </p>
      ) : null}
    </>
  );
}

function SkillGroup({ sg, open, forced, onToggle, onKey }: {
  sg: SkillGroupView; open: boolean; forced: boolean; onToggle: () => void; onKey: (e: React.KeyboardEvent) => void;
}) {
  const id = useId();
  const sumId = useId();
  const head = useRef<HTMLButtonElement>(null);
  return (
    <div className={`house-sg${open ? ' open' : ''}${forced ? ' forced' : ''}`}>
      <h5 className="house-sgh">
        <button ref={head} type="button" className="house-sgbtn" data-house-gh aria-expanded={open} aria-controls={id} aria-disabled={forced || undefined}
          onClick={() => { if (!forced) onToggle(); }} onKeyDown={onKey}
          aria-label={skillGroupLabel(sg, forced)} aria-describedby={sumId}>
          <Icon name="chevron" size={13} />
          <span className="house-sgtext">
            <span className="house-sgname">{sg.title}</span>
            <span id={sumId} className="house-sgsum">{sg.summary}</span>
          </span>
          <span className="house-sgcount">{sg.countLine}{forced ? <span className="house-sgforced"> (showing matches)</span> : null}</span>
        </button>
      </h5>
      <div id={id} className="house-sgbody" hidden={!open}>
        {forced ? null : (
          <div className="house-sgtools">
            <BulkAction scope={{ group: sg.key }} title={sg.title} fallback={() => head.current} />
          </div>
        )}
        <ul className="house-list">
          {sg.skills.map((r) => <Row key={r.file.path} f={r.file} skill={r} />)}
        </ul>
      </div>
    </div>
  );
}

/** The on/off switch for one file. A real checkbox with role=switch, so keyboard and screen readers work. */
function SwitchControl({ f, label, describedBy, caption }: { f: HouseFileView; label: string; describedBy?: string; caption?: string }) {
  const switching = useHouse((s) => s.switching.includes(f.path));
  const verb = f.category === 'skills' ? 'open' : 'read';
  return (
    <label className={`house-sw${switching ? ' busy' : ''}`} title={switching ? 'Saving…' : f.on ? `On: agents can ${verb} this.` : 'Off: agents are not shown this.'}>
      {caption ? <span className="house-swcap">{caption}</span> : null}
      {/* aria-disabled, not disabled: a disabled control drops keyboard focus while it saves. The change is ignored meanwhile. */}
      <input type="checkbox" role="switch" checked={f.on} aria-disabled={switching || undefined} aria-label={caption ? `${caption}: ${label}` : label} aria-describedby={describedBy}
        onChange={(e) => { if (!switching) void setHouseSwitch(f.path, e.target.checked); }} />
      <span className="house-swtrack" aria-hidden="true"><i /></span>
      <span className="house-swtext">{f.on ? 'On' : 'Off'}</span>
    </label>
  );
}

function Row({ f, skill }: { f: HouseFileView; skill?: SkillGroupView['skills'][number] }) {
  const busyPath = useHouse((s) => s.busyPath);
  const err = useHouse((s) => s.switchErrors[f.path]);
  const trustErr = useHouse((s) => s.trustErrors[f.path]);
  const licenceNames = useHouse((s) => s.licenceNames);
  const descId = useId();
  const busy = busyPath === f.path;
  const disabled = busyPath !== null && !busy;
  const approvable = f.trust !== 'shipped';
  const label = skill ? skill.displayTitle : displayTitle(f);
  const meaning = `${trustBlurb(f)}${f.locked ? ` ${LOCK_REASON}` : ''}`;
  const licenceNamesFor = skill ? licenceLabels(skill.licences.map((l) => licenceNames[l.path] ?? '')) : [];
  // The trust sentence is attached once per row: to Approve when the row has it, else to the switch. A locked row has
  // neither, so there the sentence is plain text for a screen reader.
  const hasControl = approvable || !f.locked;
  return (
    <li className={`house-row t-${f.trust}${f.on ? ' is-on' : ' is-off'}`}>
      <span id={descId} className={hasControl ? undefined : 'sr-only'} hidden={hasControl}>{meaning}</span>
      <div className="house-line">
        <div className="house-main">
          <span className="house-title" title={label}>{label}</span>
          {skill && f.description ? <span className="house-desc">{f.description}</span> : null}
          {pathIsRedundant(f.path, label) ? null : <span className="house-path" title={f.path}>{f.path}</span>}
          <span className="house-meta">
            <span className={`house-tag t-${f.trust}`}>{trustLabel(f)}</span>
            <span className="house-bytes">{formatBytes(f.bytes)}</span>
            {skill ? (
              <>
                {skill.references ? <span>+ {plural(skill.references, 'reference file')}</span> : null}
                {skill.licences.map((l, i) => {
                  const text = licenceNamesFor[i] ?? 'Licence';
                  return (
                    <button key={l.path} type="button" className="link-btn" aria-label={`${text} for ${label}`}
                      onClick={() => void openHouseFile(l.path, `${text}: ${label}`)}>
                      {text}
                    </button>
                  );
                })}
                <button type="button" className="link-btn" aria-label={`Read it: ${label}`} onClick={() => void openHouseFile(f.path, label)}>
                  Read it
                </button>
              </>
            ) : null}
          </span>
        </div>
        <div className="house-actions">
          {approvable ? (
            <button type="button" className={`btn sm${f.trust === 'adopted' ? '' : ' primary'}`} aria-disabled={busy || disabled} aria-busy={busy || undefined}
              aria-describedby={descId} onClick={() => { if (busy || disabled) return; void setHouseTrust(f.path, f.trust !== 'adopted'); }}>
              {busy ? <><span className="spin" /> Saving{'…'}</> : f.trust === 'adopted' ? 'Withdraw approval' : 'Approve as my rules'}
            </button>
          ) : null}
          {f.locked ? (
            <span className="house-lock"><Icon name="lock" size={13} /> Always on</span>
          ) : <SwitchControl f={f} label={label} describedBy={approvable ? undefined : descId} />}
        </div>
      </div>
      {trustErr ? <div className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`Could not save the approval: ${trustErr}`)}</span></div> : null}
      {err ? <div className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`Could not save: ${err}`)} The switch is still {f.on ? 'on' : 'off'}.</span></div> : null}
    </li>
  );
}

/** "owner/repo" for a github.com address, else the address as typed. */
const repoName = (url: string): string => /^https?:\/\/github\.com\/([^/]+\/[^/?#]+)/i.exec(url)?.[1] ?? url;

/**
 * The full text of a file in the app's own dialog (focus trap, Esc, focus returns to the button that opened it).
 * It opens with focus on the text, and carries the skill's own switch, so a skill can be turned on right after reading it.
 */
function ReadDialog() {
  const r = useHouse((s) => s.reading);
  const files = useHouse((s) => s.status?.files);
  const file = r ? files?.find((f) => f.path === r.path) : undefined;
  const category = file?.category ?? 'skills';
  // A licence or reference file has no switch of its own: the dialog offers the switch of the skill it belongs to.
  const skillFile = category === 'skills' && file?.skill ? files?.find((f) => f.path === file.skill) : undefined;
  const text = r?.status === 'ready' ? r.text : '';
  const doc = useMemo(() => parseSkillText(text), [text]);
  const body = useMemo(() => dropLeadingTitle(doc.body, r?.title ?? ''), [doc.body, r?.title]);
  const stateId = useId();
  const readEl = useRef<HTMLElement | null>(null);
  const retryEl = useRef<HTMLButtonElement>(null);
  // The dialog opens while its text is still loading, so Modal can only park focus on Close. Once the text is there
  // (or the read failed) focus goes to it, unless the owner has already moved on to something else in the dialog.
  const status = r?.status;
  useEffect(() => {
    if (!status || status === 'loading') return;
    const a = document.activeElement;
    const parked = !a || a === document.body || !!a.closest('.modal-head');
    if (!parked) return;
    (status === 'ready' ? readEl.current : retryEl.current)?.focus();
  }, [status, r?.path]);
  if (!r) return null;
  // A licence is shown as typed: its line breaks and indentation are the legal text. Everything else is markdown.
  const licence = LICENCE_RE.test(r.path.split('/').pop() ?? '');
  const same = (x: string, y: string): boolean => x.trim().toLowerCase() === y.trim().toLowerCase();
  const skillName = doc.name ? humaniseSkillName(doc.name) : '';
  const facts = [
    // The skill's name is the dialog's title already, so it is not said again here.
    skillName && !same(skillName, r.title) ? skillName : '',
    doc.licence ? `Licence ${doc.licence}` : '',
  ].filter(Boolean);
  return createPortal(
    <Modal title={r.title} width={720} onClose={closeHouseFile}
      footer={<>
        <span className="house-readpath" title={r.path}>{r.path}</span>
        <span style={{ flex: 1 }} />
        {skillFile ? <SwitchControl f={skillFile} caption="Use this skill" label={humaniseSkillName(skillFile.path.split('/').slice(-2, -1)[0] ?? 'skill')} describedBy={stateId} /> : null}
        <button type="button" className="btn" onClick={closeHouseFile}>Done</button>
      </>}>
      {r.status === 'loading' ? <div className="set-loading"><span className="spin" /> Reading the file{'…'}</div> : null}
      {r.status === 'error' ? (
        <div className="set-error" role="alert">
          <Icon name="x" size={13} /> <span>{endSentence(`Could not read this file: ${r.error ?? 'unknown error'}`)}</span>
          <button ref={retryEl} type="button" className="btn sm" onClick={() => void openHouseFile(r.path, r.title)}>Try again</button>
        </div>
      ) : null}
      {r.status === 'ready' ? (
        <>
          {file?.description && file.path === r.path ? <p className="house-readdesc">{file.description}</p> : null}
          {r.trust ? <p id={stateId} className="set-hint">{trustBlurb({ trust: r.trust, category, on: skillFile?.on })}</p> : null}
          {r.clipped ? <p className="set-hint">Showing the start of a long file.</p> : null}
          {facts.length || doc.source || doc.commit ? (
            <p className="house-readmeta">
              {facts.map((x, i) => <span key={x}>{i ? ' · ' : ''}{x}</span>)}
              {doc.source ? (
                <span>{facts.length ? ' · ' : ''}From{' '}
                  <button type="button" className="link-btn" onClick={() => openExternal(doc.source)} title={doc.source}>{repoName(doc.source)}</button>
                </span>
              ) : null}
              {doc.commit ? <span>{facts.length || doc.source ? ' · ' : ''}Pinned at <code>{doc.commit}</code></span> : null}
            </p>
          ) : null}
          {licence ? (
            <pre ref={(el) => { readEl.current = el; }} className="house-read" tabIndex={0} data-autofocus aria-label={`Text of ${r.path}`}>{r.text}</pre>
          ) : (
            <div ref={(el) => { readEl.current = el; }} className="house-read house-readmd" tabIndex={0} data-autofocus role="region" aria-label={`Text of ${r.path}`}><Markdown text={body} headingOffset={2} quietCode /></div>
          )}
        </>
      ) : null}
    </Modal>,
    document.body,
  );
}
