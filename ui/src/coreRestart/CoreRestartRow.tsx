import { useEffect, useState } from 'react';
import { CORE_OPTION_HINT, CORE_OPTION_LABEL } from './coreRestartText';
import { coreRestartOption } from './coreRestartStore';

/** Settings, About: the switch for restarting Legion Core by itself. Main keeps it in the data folder, so it works while the core is down. */
export function CoreRestartRow() {
  const [on, setOn] = useState(true);
  useEffect(() => { let live = true; void coreRestartOption().then((v) => { if (live) setOn(v); }); return () => { live = false; }; }, []);
  return (
    <div className="set-group">
      <label className="set-check">
        <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); void coreRestartOption(e.target.checked).then(setOn); }} />
        <span><b>{CORE_OPTION_LABEL}</b><em>{CORE_OPTION_HINT}</em></span>
      </label>
    </div>
  );
}
