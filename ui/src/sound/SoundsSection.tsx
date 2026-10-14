import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { AwaySounds } from '../api';
import { errText } from '../store';
import { loadAway, useAway } from '../projects/awayStore';
import { DEFAULT_SOUND_PREFS } from './soundLogic';
import { listPacks, packOrDefault } from './soundPacks';
import { playFeedback, previewPack } from './soundService';
import '../away/away.css';
import './sounds.css';

const DEFAULTS: AwaySounds = { enabled: DEFAULT_SOUND_PREFS.enabled, pack: DEFAULT_SOUND_PREFS.pack, volume: DEFAULT_SOUND_PREFS.volume };

/** Settings, Sounds: a master switch, a pack, a volume. Stored by the core with the other app settings (/api/away/app). */
export function SoundsSection() {
  const stored = useAway((s) => s.view?.app.sounds);
  const loaded = useAway((s) => s.loaded);
  const [err, setErr] = useState<string | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const sounds = stored ?? DEFAULTS;
  const packs = listPacks();
  const pack = packOrDefault(sounds.pack, packs);
  const shown = volume ?? sounds.volume;

  const patch = async (body: Partial<AwaySounds>): Promise<boolean> => {
    try { await request('PATCH', '/api/away/app', { sounds: body }); await loadAway(); setErr(null); return true; } catch (e) { setErr(errText(e)); void loadAway(); return false; }
  };
  const onVolume = (v: number): void => {
    setVolume(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void patch({ volume: v }).then(() => setVolume(null)); }, 250);
  };

  return (
    <div className="set-section away-section sounds-section">
      <header className="set-head"><h3>Sounds</h3><p>Quiet sounds for the moments that matter: something needs you, a run finishes or fails, and your Allow or Deny. Typing, clicking around and streaming stay silent. Sounds follow the quiet hours above.</p></header>
      {err && <p className="set-error" role="alert">{err}</p>}
      {!loaded && !err && <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}
      {loaded && (
        <>
          <label className="set-check">
            <input type="checkbox" data-no-sound="" checked={sounds.enabled} onChange={(e) => { const on = e.target.checked; void patch({ enabled: on }).then((ok) => { if (ok && on) playFeedback('check', shown, pack); }); }} />
            <span><b>Play sounds</b><em>Turn this off and Legion makes no sound at all.</em></span>
          </label>
          <div className="sounds-volume">
            <label htmlFor="sounds-volume">Volume</label>
            <input id="sounds-volume" type="range" min={0} max={100} step={5} value={Math.round(shown * 100)} disabled={!sounds.enabled}
              aria-valuetext={`${Math.round(shown * 100)} percent`} onChange={(e) => onVolume(Number(e.target.value) / 100)} />
            <output htmlFor="sounds-volume">{Math.round(shown * 100)}%</output>
          </div>
          <fieldset className="away-quiet sounds-packs" disabled={!sounds.enabled}>
            <legend>Sound pack</legend>
            <ul>
              {packs.map((p) => (
                <li key={p.id} className={pack === p.id ? 'sel' : ''}>
                  <label className="sounds-pick">
                    <input type="radio" name="sound-pack" value={p.id} checked={pack === p.id} onChange={() => void patch({ pack: p.id })} />
                    <span><b>{p.label}</b><em>{p.description}</em></span>
                  </label>
                  <button type="button" className="btn sm" onClick={() => previewPack(p.id, shown)} aria-label={`Play a sample of the ${p.label} pack`}>Play</button>
                </li>
              ))}
            </ul>
          </fieldset>
          <p className="set-hint">Playing a sample plays three sounds: something needs you, Allow, and a run finished.</p>
        </>
      )}
    </div>
  );
}
