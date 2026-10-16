import { useState } from 'react';
import { Switch } from '../projects/page/Switch';
import { readFocusRings, setFocusRings } from './focusRings';
import '../sound/sounds.css';

/** Settings, Accessibility: one switch for focus rings. Off by default; on brings back the rings for keyboard focus. */
export function AccessibilitySection() {
  const [on, setOn] = useState(readFocusRings);
  return (
    <div className="set-section">
      <header className="set-head"><h3>Accessibility</h3><p>How keyboard focus shows on your screen.</p></header>
      <div className="snd-opt">
        <div><b>Show focus rings</b><span className="snd-h">Outlines around the focused item when you use the keyboard</span></div>
        <Switch id="a11y-focus-rings" on={on} label="Show focus rings" onChange={(v) => { setFocusRings(v); setOn(v); }} />
      </div>
    </div>
  );
}
