/**
 * The Skills section of the agent editor: "Same as the Armory" (the default) or "Choose skills" from a searchable checklist
 * grouped like the Armory, with the agent's Doctrine drills on top.
 *
 * A list only narrows. It never turns a skill on: a skill that is off in the Armory stays unavailable whatever is ticked here, and
 * the list says so. Below the choice, the screen says how many skills the agent would see with what is on screen right now and
 * warns when that crowds the prompt. The count is the same rule the core uses (accessFor, tested against it), so it also works for
 * an agent that is not saved yet.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { loadHouse, useHouse } from '../house/houseStore';
import { drillRefsOf, loadArmory, useArmory } from './armoryStore';
import { buildGroups, budgetWarning, currentGrant, draftSees, endSentence, MAX_AGENT_SKILLS, plural, seesLine, selectable, tickReason, triOf, WARN_ABOVE, accessFor } from '../../../src/shared/armory-view';
import type { ArmoryGroup, ArmorySkill, DrillRef } from '../../../src/shared/armory-view';
import { drillId } from '../../../src/shared/skill-ids';
import './armory.css';

export interface AgentSkillsValue { mode: 'inherit' | 'choose'; ids: string[] }

/** The starting value for an agent's saved setting. */
export const valueOf = (setting: 'inherit' | string[] | undefined): AgentSkillsValue =>
  Array.isArray(setting) ? { mode: 'choose', ids: [...setting] } : { mode: 'inherit', ids: [] };

/** What goes in the PATCH body. */
export const settingOf = (v: AgentSkillsValue): 'inherit' | string[] => (v.mode === 'inherit' ? 'inherit' : v.ids);

interface Row { id: string; name: string; description: string; note: string; /** Why this tick has no effect for this agent, and where to change it. Empty when it does. */ why: string; on: boolean }
interface Grp { key: string; title: string; hint: string; rows: Row[]; /** The ids a group tick acts on: only what can reach an agent. */ live: string[]; collapsed: boolean }

export function AgentSkills({ agentId, agentName, value, onChange, onOpenArmory }: { agentId: string | null; agentName: string; value: AgentSkillsValue; onChange: (v: AgentSkillsValue) => void; /** Open the Armory at this skill. */ onOpenArmory?: (skillId: string) => void }) {
  const data = useArmory((s) => s.data);
  const loaded = useArmory((s) => s.loaded);
  const loadError = useArmory((s) => s.loadError);
  const loading = useArmory((s) => s.loading);
  const files = useHouse((s) => s.status?.files);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showList, setShowList] = useState(false);
  const name = useId();
  useEffect(() => { if (!loaded) void loadArmory(); void loadHouse(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const skills = data?.skills ?? [];
  const drills: DrillRef[] = useMemo(() => drillRefsOf(files), [files]);
  const descOf = useMemo(() => new Map((files ?? []).filter((f) => !!f.description).map((f) => [drillId(f.group ?? '', f.path.split('/').slice(-2, -1)[0] ?? ''), f.description!])), [files]);
  const id = agentId ?? '';
  const chosen = useMemo(() => new Set(value.ids.map((x) => x.toLowerCase())), [value.ids]);
  const has = (x: string): boolean => chosen.has(x.toLowerCase());

  const who = agentName.trim() || 'This agent';
  const groups: Grp[] = useMemo(() => {
    const out: Grp[] = [];
    if (drills.length) {
      out.push({
        key: 'drills', title: 'Drills', hint: 'from Doctrine', collapsed: false,
        rows: drills.map((d) => ({ id: d.id, name: d.name, description: descOf.get(d.id) ?? '', note: d.on ? '' : 'Off in Doctrine', why: '', on: d.on })),
        live: drills.filter((d) => d.on).map((d) => d.id),
      });
    }
    const q = query.trim();
    const g: ArmoryGroup[] = buildGroups(selectable(skills), 'all', q);
    for (const x of g) {
      out.push({
        key: x.key, title: x.title, hint: x.hint, collapsed: x.collapsed,
        rows: x.skills.map((s: ArmorySkill) => { const why = tickReason(s, id, who); return { id: s.id, name: s.name, description: s.description, note: '', why, on: !why }; }),
        // A group tick acts only on what can reach this agent: not on a skill that is off, only-when-asked, or limited to other agents.
        live: x.all.filter((s) => accessFor(s, { id, skills: 'inherit' }) === 'on').map((s) => s.id),
      });
    }
    const wanted = (r: Row): boolean => !q || `${r.name} ${r.description} ${r.id}`.toLowerCase().includes(q.toLowerCase());
    // The drills group has no search of its own in buildGroups, so it is narrowed here.
    return out.map((x) => (x.key === 'drills' ? { ...x, rows: x.rows.filter(wanted) } : x)).filter((x) => x.rows.length);
  }, [skills, drills, descOf, query, id, who]);

  const set = (ids: string[]): void => onChange({ mode: 'choose', ids });
  const toggleOne = (rid: string, on: boolean): void => {
    const rest = value.ids.filter((x) => x.toLowerCase() !== rid.toLowerCase());
    set(on ? [...rest, rid] : rest);
  };
  const toggleGroup = (g: Grp): void => {
    const state = triOf(g.live, chosen);
    const liveSet = new Set(g.live.map((x) => x.toLowerCase()));
    const rest = value.ids.filter((x) => !liveSet.has(x.toLowerCase()));
    set(state === 'all' ? rest : [...rest, ...g.live]);
  };
  const switchMode = (mode: 'inherit' | 'choose'): void => {
    if (mode === value.mode) return;
    // "Choose skills" starts from what the agent gets now, so nothing changes until the owner unticks something.
    onChange(mode === 'inherit' ? { mode, ids: value.ids } : { mode, ids: value.ids.length ? value.ids : currentGrant(skills, drills, id, 'inherit') });
  };

  const setting = settingOf(value);
  const sees = draftSees(skills, drills, id, setting, WARN_ABOVE);
  const tooMany = value.mode === 'choose' && value.ids.length > MAX_AGENT_SKILLS;
  const list = useMemo(() => {
    const a = { id, skills: setting };
    const on = skills.filter((s) => accessFor(s, a) === 'on');
    return {
      drills: drills.filter((d) => d.on && (setting === 'inherit' || setting.some((x) => x.toLowerCase() === d.id))).map((d) => d.name),
      armory: on.filter((s) => s.source === 'yours' || s.source === 'imported').map((s) => s.name),
      claudeCode: on.filter((s) => s.source !== 'yours' && s.source !== 'imported').map((s) => s.name),
    };
  }, [skills, drills, id, setting]);
  const noneYet = !skills.length && !drills.length;

  return (
    <fieldset className="arm-agentskills">
      <legend>Skills</legend>
      <label className="arm-check">
        <input type="radio" name={name} checked={value.mode === 'inherit'} onChange={() => switchMode('inherit')} data-skills-focus={value.mode === 'inherit' ? '' : undefined} />
        <span>Same as the Armory <span className="arm-faint">(default)</span></span>
      </label>
      <p className="field-note arm-indent">{who} gets the skills that are on in the Armory for this agent, and your drills that are on.</p>
      <label className="arm-check">
        <input type="radio" name={name} checked={value.mode === 'choose'} onChange={() => switchMode('choose')} data-skills-focus={value.mode === 'choose' ? '' : undefined} />
        <span>Choose skills</span>
      </label>

      {value.mode === 'choose' ? (
        <div className="arm-pick">
          <p className="field-note">
            Tick the skills this agent may use. A skill that is off in the Armory stays unavailable even when ticked, and a skill you turn on later is not added to this list.
          </p>
          {loadError && !loaded ? (
            <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{endSentence(`Could not read the skills: ${loadError}`)}</span>
              <button type="button" className="btn sm" aria-disabled={loading} onClick={() => { if (!loading) void loadArmory(); }}>{loading ? <>Trying{'…'}</> : 'Try again'}</button>
            </div>
          ) : null}
          {!loaded && !loadError ? <div className="set-loading"><span className="spin" /> Reading the skills{'…'}</div> : null}
          {loaded && noneYet ? <p className="field-note">There are no skills yet. Add some in Settings, Armory.</p> : null}
          {loaded && !noneYet ? (
            <>
              <input type="search" className="arm-picksearch" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={'Search skills…'} aria-label="Search skills to choose"
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
              <div className="arm-pickgroups">
                {groups.map((g) => (
                  <PickGroup key={g.key} g={g} chosen={chosen} has={has} forced={!!query.trim()} open={!!query.trim() || (open[g.key] ?? !g.collapsed)}
                    onToggleOpen={(isOpen) => setOpen((o) => ({ ...o, [g.key]: !isOpen }))} onGroup={() => toggleGroup(g)} onOne={toggleOne} {...(onOpenArmory ? { onOpenArmory } : {})} />
                ))}
                {!groups.length ? <p className="field-note">Nothing matches that search.</p> : null}
              </div>
            </>
          ) : null}
          {tooMany ? <p className="arm-fielderr" role="alert">That is {value.ids.length} skills. One agent can have at most {MAX_AGENT_SKILLS}. Untick some to save.</p> : null}
        </div>
      ) : null}

      <div className="arm-sees" aria-live="polite">
        <p className="arm-seesline">{loaded ? seesLine(who, sees) : <>Reading the skills{'…'}</>}</p>
        {loaded && sees.over ? <p className="arm-warn"><Icon name="warn" size={12} /> {budgetWarning(who, sees.total, WARN_ABOVE)}</p> : null}
        {loaded && sees.total ? (
          <button type="button" className="link-btn arm-seeslink" aria-expanded={showList} onClick={() => setShowList((v) => !v)}>{showList ? 'Hide the list' : 'Show the list'}</button>
        ) : null}
        {loaded && showList ? (
          <div className="arm-seeslist">
            {([['Drills', list.drills], ['Armory', list.armory], ['Claude Code', list.claudeCode]] as const).filter(([, n]) => n.length).map(([title, names]) => (
              <p key={title}><b>{title} ({names.length}):</b> {names.join(', ')}</p>
            ))}
          </div>
        ) : null}
        {agentId === null ? <p className="field-note">The count uses what is on today. Skills limited to certain agents are left out until the agent is saved.</p> : null}
      </div>
    </fieldset>
  );
}

function PickGroup({ g, chosen, has, forced, open, onToggleOpen, onGroup, onOne, onOpenArmory }: {
  g: Grp; chosen: ReadonlySet<string>; has: (id: string) => boolean; forced: boolean; open: boolean;
  onToggleOpen: (isOpen: boolean) => void; onGroup: () => void; onOne: (id: string, on: boolean) => void; onOpenArmory?: (skillId: string) => void;
}) {
  const bid = useId();
  const tri = triOf(g.live, chosen);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = tri === 'some'; }, [tri]);
  const picked = g.rows.filter((r) => has(r.id)).length;
  // Drills are drills here too: the group is called Drills, and so are its parts.
  const noun = g.key === 'drills' ? 'drill' : 'skill';
  return (
    <div className={`arm-pickgroup${open ? ' open' : ''}`}>
      <div className="arm-pickhead">
        <input ref={box} type="checkbox" checked={tri === 'all'} aria-disabled={!g.live.length || undefined} aria-label={`Choose every ${noun} that is on in ${g.title}`}
          onChange={() => { if (g.live.length) onGroup(); }} />
        <button type="button" className="arm-pickbtn" aria-expanded={open} aria-controls={bid} aria-disabled={forced || undefined} onClick={() => { if (!forced) onToggleOpen(open); }}>
          <Icon name="chevron" size={12} />
          <span className="arm-pickname">{g.title}</span>
          <span className="arm-pickcount">{plural(picked, noun)} chosen of {g.rows.length}{g.live.length < g.rows.length ? `, ${g.live.length} on` : ''}</span>
        </button>
      </div>
      {/* The rows of a closed group are not drawn: a long list of skills that are off would otherwise carry hundreds of hidden buttons. */}
      <div id={bid} hidden={!open}>
        {open ? (
          <ul className="arm-picklist">
            {g.rows.map((r) => (
              <li key={r.id}>
                <label className={`arm-check${r.on ? '' : ' dim'}`}>
                  <input type="checkbox" checked={has(r.id)} onChange={(e) => onOne(r.id, e.target.checked)} />
                  <span className="arm-picktext">
                    <span className="arm-pickrow">{r.name}{r.note ? <span className="house-tag arm-pickflag">{r.note}</span> : null}</span>
                    {r.description ? <span className="arm-pickdesc">{r.description}</span> : null}
                  </span>
                </label>
                {r.why ? (
                  <p className="arm-pickwhy">
                    <span>{r.why}</span>
                    {/* The way out is offered where it matters: a skill that is ticked and has no effect. An unticked one only says why it is dim. */}
                    {onOpenArmory && has(r.id) ? <button type="button" className="link-btn" aria-label={`Open ${r.name} in the Armory`} onClick={() => onOpenArmory(r.id)}>Open in the Armory</button> : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
