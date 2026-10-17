/**
 * The Skill finder control of the agent editor: follow the Armory, suggest skills every turn for this agent, or switch the finder
 * off for it. The rules (what is sent, what a choice clears) live in src/shared/agent-finder.ts, which the tests pin down.
 */
import { useId } from 'react';
import { FINDER_MODES, pickFinderMode } from '../../../src/shared/agent-finder';
import type { FinderForm, FinderMode } from '../../../src/shared/agent-finder';

export function AgentFinder({ value, onChange }: { value: FinderForm; onChange: (v: FinderForm) => void }) {
  const note = useId();
  return (
    <div className="row afnd">
      <label className="grow">Skill finder
        <select value={value.mode} aria-describedby={value.mode === 'off' ? note : undefined} onChange={(e) => onChange(pickFinderMode(value, e.target.value as FinderMode))}>
          {FINDER_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {value.mode === 'off' && <span id={note} className="field-note">With search off, this agent always gets the full skill list.</span>}
      </label>
      {value.mode !== 'off' && (
        <label className="grow">Skills per suggestion
          <select value={value.k ?? ''} onChange={(e) => onChange({ ...value, k: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">Same as the Armory</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
