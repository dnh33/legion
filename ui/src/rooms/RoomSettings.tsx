import { useState } from 'react';
import type { Room, RoomGuards, RoomStrategy } from '../../../src/shared/comms';
import { Icon } from '../components/icons';
import { Face } from './Stack';
import { useStore } from '../store';
import { Dialog } from './Dialog';
import './rooms.css';
import { deleteRoom, saveRoomSettings, setSettingsOpen } from './roomsStore';
import { STRATEGY_INFO } from './roomsUtil';

const MAX = 6;
const STRATS = Object.keys(STRATEGY_INFO) as RoomStrategy[];

export function RoomSettings({ room }: { room: Room }) {
  const agents = useStore((s) => s.agents);
  const dm = room.kind === 'dm';
  const [name, setName] = useState(room.name);
  const [strategy, setStrategy] = useState<RoomStrategy>(room.strategy);
  const [members, setMembers] = useState<string[]>(room.members);
  const [leadPick, setLeadPick] = useState(room.lead);
  const [maxHops, setMaxHops] = useState(String(room.guards.maxHops));
  const [budget, setBudget] = useState(String(room.guards.budgetUsd));
  const [cycle, setCycle] = useState(String(room.guards.cycleRepeats));
  const [cool, setCool] = useState(String(room.guards.everyoneCooldownSec));
  const [adding, setAdding] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const lead = members.includes(leadPick) ? leadPick : (members[0] ?? '');
  const nm = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const addable = agents.filter((a) => !members.includes(a.id));

  const num = (v: string, lo: number, hi: number, int: boolean) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) && n >= lo && n <= hi && (!int || Number.isInteger(n)) ? n : null; };
  const nHops = num(maxHops, 1, 100, true);
  const nBudget = num(budget, 0.05, 10_000, false);
  const nCycle = num(cycle, 2, 50, true);
  const nCool = num(cool, 0, 86_400, false);
  const nameOk = name.trim().length > 0 && name.trim().length <= 80;
  const membersOk = members.length >= 2 && members.length <= MAX;
  const bad = !nameOk ? 'Name is required (80 characters max).' : !membersOk ? 'A group needs 2 to 6 agents.'
    : nHops === null ? 'Max hops: whole number, 1 to 100.' : nBudget === null ? 'Budget: $0.05 to $10,000.'
    : nCycle === null ? 'Repeats: whole number, 2 to 50.' : nCool === null ? 'Cooldown: 0 to 86,400 seconds.' : '';

  const added = members.filter((m) => !room.members.includes(m));
  const removed = room.members.filter((m) => !members.includes(m));
  const dirty = name.trim() !== room.name || strategy !== room.strategy || lead !== room.lead || added.length > 0 || removed.length > 0
    || nHops !== room.guards.maxHops || nBudget !== room.guards.budgetUsd || nCycle !== room.guards.cycleRepeats || nCool !== room.guards.everyoneCooldownSec;

  const save = async () => {
    if (bad || busy || !dirty) return;
    setBusy(true); setErr('');
    const guards: Partial<RoomGuards> = {};
    if (nHops !== room.guards.maxHops) guards.maxHops = nHops!;
    if (nBudget !== room.guards.budgetUsd) guards.budgetUsd = nBudget!;
    if (nCycle !== room.guards.cycleRepeats) guards.cycleRepeats = nCycle!;
    if (nCool !== room.guards.everyoneCooldownSec) guards.everyoneCooldownSec = nCool!;
    try {
      await saveRoomSettings(room.id, {
        name: name.trim() !== room.name ? name.trim() : undefined,
        strategy: strategy !== room.strategy ? strategy : undefined,
        lead: lead !== room.lead ? lead : undefined,
        guards, add: added, remove: removed,
      });
      setSettingsOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  const del = async () => {
    setBusy(true); setErr('');
    try { await deleteRoom(room.id); setSettingsOpen(false); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <Dialog title="Room settings" width={620} onClose={() => setSettingsOpen(false)}
      footer={<>
        {confirmDel
          ? <><span className="muted-s">Delete this room and its transcript?</span><button type="button" className="btn danger" disabled={busy} onClick={() => void del()}>Yes, delete</button><button type="button" className="btn-ghost" onClick={() => setConfirmDel(false)}>No</button></>
          : <button type="button" className="btn-ghost danger" onClick={() => setConfirmDel(true)}>Delete room</button>}
        <span className="spacer" />
        {bad && <span className="muted-s rm-badnote" role="status">{bad}</span>}
        <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(false)}>Cancel</button>
        <button type="button" className="btn primary" disabled={!!bad || busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Name<input data-autofocus value={name} maxLength={90} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
        {room.createdBy && <p className="field-note" role="note">Created by {nm(room.createdBy)}, with your approval. Bots can ask to add or remove members (you get a card each time); only you can change the guards or delete the room.</p>}

        <fieldset className="rm-fs">
          <legend>Members <span className="rm-count">{members.length} of {MAX}</span></legend>
          {dm && <p className="muted-s">Direct messages are created by the bots themselves and always have exactly two members.</p>}
          <ul className="rm-members" aria-label="Members">
            {members.map((id) => (
              <li key={id} className="rm-member">
                <Face id={id} size={24} />
                <span className="rm-member-name">{nm(id)}</span>
                {lead === id && <span className="rm-pill">lead</span>}
                <span className="spacer" />
                {!dm && <button type="button" className="btn-ghost sm danger" disabled={members.length <= 2} onClick={() => setMembers((m) => m.filter((x) => x !== id))}
                  aria-label={`Remove ${nm(id)}`} title={members.length <= 2 ? 'A group needs at least 2 members' : `Remove ${nm(id)}`}>Remove</button>}
              </li>
            ))}
          </ul>
          {!dm && (
            <div className="rm-addrow">
              <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Agent to add" disabled={members.length >= MAX || addable.length === 0}>
                <option value="">{members.length >= MAX ? 'Room is full (6)' : addable.length === 0 ? 'Every agent is already in' : 'Add an agent…'}</option>
                {addable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button type="button" className="btn sm" disabled={!adding} onClick={() => { setMembers((m) => [...m, adding]); setAdding(''); }}><Icon name="plus" size={13} /> Add</button>
            </div>
          )}
          {(added.length > 0 || removed.length > 0) && <p className="field-note">Applies on Save. {removed.length > 0 && 'Removed bots lose their running work in this room.'}</p>}
        </fieldset>

        <div className="row">
          <label className="grow">Lead
            <select value={lead} onChange={(e) => setLeadPick(e.target.value)}>{members.map((id) => <option key={id} value={id}>{nm(id)}</option>)}</select>
            <span className="field-note">Answers messages that name nobody.</span>
          </label>
        </div>

        <fieldset className="rm-fs">
          <legend>Who answers</legend>
          <div className="rm-strats" role="radiogroup" aria-label="Strategy">
            {STRATS.map((s) => (
              <label key={s} className={`rm-strat${strategy === s ? ' on' : ''}`}>
                <input type="radio" name="strategy" value={s} checked={strategy === s} onChange={() => setStrategy(s)} />
                <span><b>{STRATEGY_INFO[s].label}</b><span>{STRATEGY_INFO[s].desc}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="rm-fs">
          <legend>Guards</legend>
          <div className="row">
            <label className="grow">Max hops
              <input type="number" min={1} max={100} step={1} value={maxHops} onChange={(e) => setMaxHops(e.target.value)} aria-invalid={nHops === null} />
            </label>
            <label className="grow">Budget (USD)
              <input type="number" min={0.05} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={nBudget === null} />
            </label>
          </div>
          <div className="row">
            <label className="grow">Loop trips after (repeats)
              <input type="number" min={2} max={50} step={1} value={cycle} onChange={(e) => setCycle(e.target.value)} aria-invalid={nCycle === null} />
            </label>
            <label className="grow">@everyone cooldown (s)
              <input type="number" min={0} step={5} value={cool} onChange={(e) => setCool(e.target.value)} aria-invalid={nCool === null} />
            </label>
          </div>
          <p className="field-note">Guards are enforced by Legion, not by prompts. Hitting one pauses the room until you resume it. Right now: {room.hopsSinceHuman} bot-to-bot hops since your last message.</p>
        </fieldset>
        {err && <p className="err-s" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}
