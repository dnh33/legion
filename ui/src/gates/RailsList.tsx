import { Icon } from '../components/icons';
import { qaRows, railRows } from './presetsLogic';

/** The QA gates, read only: they follow each goal's care level. Nothing here until goals ship: a card with no rows would be a heading over an empty table. */
export function QaGates() {
  const rows = qaRows();
  if (rows.length === 0) return null;
  const cell = (on: boolean) => (on ? 'On' : 'Off');
  return (
    <div className="set-card gates-qa" aria-label="QA gates">
      <h3>QA gates</h3>
      <p className="field-note">These follow each goal's care level. A goal can turn them down; its result then says what was not checked.</p>
      <div className="gates-table-wrap">
        <table className="gates-table">
          <thead><tr><th scope="col">Check</th><th scope="col">Quick</th><th scope="col">Normal</th><th scope="col">Thorough</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row"><div className="gates-cellstack"><span>{r.label}</span><span className="field-note">{r.protects}</span></div></th>
                <td>{cell(r.quick)}</td><td>{cell(r.normal)}</td><td>{cell(r.thorough)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The rails: decided before any rule, always on, with no switch. */
export function RailsList() {
  return (
    <div className="set-card gates-rails" aria-label="Rails">
      <h3><Icon name="shield" size={14} /> Rails</h3>
      <p className="field-note">These are decided before rules and cannot be changed here. Every one of them is stricter than any rule could make it.</p>
      <ul className="gates-rail-list">
        {railRows().map((r) => (
          <li key={r.id} className="gates-row">
            <span className="gates-rail-text"><b>{r.label}</b><span className="field-note">{r.protects}</span></span>
            <span className="gates-always">Always on</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
