import { useMemo, useState } from 'react';
import type { RoomStrategy } from '../../../src/shared/comms';
import { DEFAULT_GUARDS } from '../../../src/shared/comms';
import { Face } from './Stack';
import { useStore } from '../store';
import { Dialog } from './Dialog';
import './rooms.css';
import { createRoom, setNewRoomOpen } from './roomsStore';
import { STRATEGY_INFO } from './roomsUtil';

const MAX = 6;
const STRATS = Object.keys(STRATEGY_INFO) as RoomStrategy[];

export function NewRoomDialog() {
  const agents = useStore((s) => s.agents);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [leadPick, setLeadPick] = useState<string>('');
  const [strategy, setStrategy] = useState<RoomStrategy>('mention');
  const [maxHops, setMaxHops] = useState(String(DEFAULT_GUARDS.maxHops));
  const [budget, setBudget] = useState(String(DEFAULT_GUARDS.budgetUsd));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const lead = picked.includes(leadPick) ? leadPick : (picked[0] ?? '');
  const hops = Number(maxHops); const usd = Number(budget);
  const hopsOk = Number.isInteger(hops) && hops >= 1 && hops <= 100;
  const usdOk = Number.isFinite(usd) && usd >= 0.01 && usd <= 10_000;
  const nameOk = name.trim().length > 0 && name.trim().length <= 80;
  const valid = nameOk && picked.length >= 2 && picked.length <= MAX && hopsOk && usdOk;
  const why = useMemo(() => {
    if (!nameOk) return name.trim().length > 80 ? 'Name is limited to 80 characters.' : 'Give the room a name.';
    if (picked.length < 2) return 'Pick at least two agents.';
    if (!hopsOk) return 'Max hops must be a whole number from 1 to 100.';
    if (!usdOk) return 'Budget must be between $0.01 and $10,000.';
    return '';
  }, [nameOk, name, picked.length, hopsOk, usdOk]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setErr('');
    try {
      await createRoom({
        name: name.trim(), members: picked, lead, strategy,
        guards: { maxHops: hops, budgetUsd: usd },
      });
      setNewRoomOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New room" width={620} onClose={() => setNewRoomOpen(false)}
      footer={<>
        <span className={`muted-s${why ? '' : ' rm-ok'}`} role="status">{why || `${picked.length} agents, ${STRATEGY_INFO[strategy].label.toLowerCase()} strategy`}</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={() => setNewRoomOpen(false)}>Cancel</button>
        <button type="button" className="btn primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create room'}</button>
      </>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Name
          <input data-autofocus value={name} maxLength={90} onChange={(e) => setName(e.target.value)} placeholder="Launch crew" autoComplete="off" />
        </label>

        <fieldset className="rm-fs">
          <legend>Agents <span className="rm-count" aria-live="polite">{picked.length} of {MAX}</span></legend>
          {agents.length < 2 && <p className="muted-s">A room needs at least two agents. Create another agent first.</p>}
          <div className="rm-pick">
            {agents.map((a) => {
              const on = picked.includes(a.id);
              const full = !on && picked.length >= MAX;
              return (
                <label key={a.id} className={`rm-pickcard${on ? ' on' : ''}${full ? ' off' : ''}`}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(a.id)} />
                  <Face id={a.id} size={26} />
                  <span className="rm-pick-text"><b>{a.name}</b><span>{a.description || a.model}</span></span>
                  {on && lead === a.id && <span className="rm-pill">lead</span>}
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="rm-fs">
          <legend>Who answers</legend>
          <div className="rm-strats" role="radiogroup" aria-label="Strategy">
            {STRATS.map((s) => (
              <label key={s} className={`rm-strat${strategy === s ? ' on' : ''}`}>
                <input type="radio" name="strategy" value={s} checked={strategy === s} onChange={() => setStrategy(s)} />
                <span><b>{STRATEGY_INFO[s].label}{s === 'mention' && <i className="rm-def"> default</i>}</b><span>{STRATEGY_INFO[s].desc}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="row rm-3">
          <label className="grow">Lead
            <select value={lead} disabled={picked.length === 0} onChange={(e) => setLeadPick(e.target.value)}>
              {picked.length === 0 && <option value="">Pick agents first</option>}
              {picked.map((id) => <option key={id} value={id}>{agents.find((a) => a.id === id)?.name ?? id}</option>)}
            </select>
            <span className="field-note">Answers when nobody is named.</span>
          </label>
          <label className="grow">Max hops
            <input type="number" min={1} max={100} step={1} value={maxHops} onChange={(e) => setMaxHops(e.target.value)} aria-invalid={!hopsOk} />
            <span className="field-note">Bot replies before a pause.</span>
          </label>
          <label className="grow">Budget (USD)
            <input type="number" min={0.01} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={!usdOk} />
            <span className="field-note">Room pauses when spent.</span>
          </label>
        </div>
        {err && <p className="err-s" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}
