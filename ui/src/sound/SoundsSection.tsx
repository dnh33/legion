import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { AwaySounds } from '../api';
import { errText } from '../store';
import { loadAway, useAway } from '../projects/awayStore';
import { Switch } from '../projects/page/Switch';
import { DEFAULT_SOUND_PREFS, EVENT_ROWS, eventDefaultOn, resolveEvent, withChoice } from './soundLogic';
import type { EventChoice, EventKey, SoundEvent, SoundPrefs } from './soundLogic';
import { cueRole, defaultPack, listCueGroups, listPacks, packOrDefault } from './soundPacks';
import type { SoundPackInfo } from './soundPacks';
import { playFeedback, previewPack, previewSound } from './soundService';
import '../away/away.css';
import './sounds.css';

const DEFAULTS: AwaySounds = { enabled: DEFAULT_SOUND_PREFS.enabled, pack: DEFAULT_SOUND_PREFS.pack, volume: DEFAULT_SOUND_PREFS.volume, events: {} };
/** The event each row previews: the same event the app reports, so the preview is the sound the row will make. */
const SAMPLE: Record<EventKey, SoundEvent> = {
  ask: { type: 'ask' }, 'run-done': { type: 'run-done' }, 'run-failed': { type: 'run-failed' }, allow: { type: 'allow' }, deny: { type: 'deny' },
  switch: { type: 'switch', on: true }, 'run-started': { type: 'run-started' },
};
const valueOf = (c: EventChoice | undefined): string => (c?.sound ? `${c.sound.pack}/${c.sound.cue}` : '');

/** Settings, Sounds: a master switch, a volume, a pack, and (folded away) a choice per event. Stored by the core with the other app settings (/api/away/app). */
export function SoundsSection() {
  const stored = useAway((s) => s.view?.app.sounds);
  const loaded = useAway((s) => s.loaded);
  const [err, setErr] = useState<string | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const sounds = stored ?? DEFAULTS;
  const packs = listPacks();
  const pack = packOrDefault(sounds.pack, packs);
  const shown = volume ?? sounds.volume;
  const events = (sounds.events ?? {}) as Partial<Record<EventKey, EventChoice>>;
  const prefs: SoundPrefs = { enabled: sounds.enabled, volume: shown, pack, events };

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    try { await request('PATCH', '/api/away/app', { sounds: body }); await loadAway(); setErr(null); return true; } catch (e) { setErr(errText(e)); void loadAway(); return false; }
  };
  const onVolume = (v: number): void => {
    setVolume(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void patch({ volume: v }).then(() => setVolume(null)); }, 250);
  };
  const change = (key: EventKey, c: { enabled?: boolean; sound?: { pack: string; cue: string } | null }): void => {
    void patch({ events: { [key]: withChoice(key, events[key], c) } });
  };
  const changedCount = EVENT_ROWS.filter((r) => events[r.key]).length;
  const groups = listCueGroups();
  const packLabel = packs.find((p) => p.id === pack)?.label ?? pack;
  const defaultId = defaultPack(packs);

  const card = (p: SoundPackInfo, big: boolean) => (
    <li key={p.id} className={`snd-pack${big ? ' big' : ''}${pack === p.id ? ' sel' : ''}`}
      onClick={(e) => { if (sounds.enabled && !(e.target as HTMLElement).closest('button, label')) void patch({ pack: p.id }); }}>
      <label className="snd-pack-pick">
        <input type="radio" name="sound-pack" value={p.id} checked={pack === p.id} aria-describedby={`snd-pd-${p.id}`} onChange={() => void patch({ pack: p.id })} />
        <b>{p.label}</b>{p.id === defaultId && <span className="pg-tag">Default</span>}
      </label>
      <button type="button" className="btn sm" onClick={() => previewPack(p.id, shown)} aria-label={`Play a sample of the ${p.label} pack`}>Play</button>
      <p id={`snd-pd-${p.id}`}>{p.description}</p>
    </li>
  );

  return (
    <div className="set-section away-section sounds-section">
      <header className="set-head"><h3>Sounds</h3><p>Quiet sounds for the moments that matter: something needs you, a run finishes or fails, and your Allow or Deny. Typing, clicking around and streaming stay silent. Sounds follow the quiet hours above.</p></header>
      {err && <p className="set-error" role="alert">{err}</p>}
      {!loaded && !err && <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}
      {loaded && (
        <>
          <div className="snd-opt">
            <div><b>Play sounds</b><span className="snd-h">Turn this off and Legion makes no sound at all.</span></div>
            <Switch id="snd-master" on={sounds.enabled} label="Play sounds" onChange={(on) => { void patch({ enabled: on }).then((ok) => { if (ok && on) playFeedback('check', shown, pack); }); }} />
          </div>
          <div className="snd-opt snd-vol">
            <label htmlFor="sounds-volume"><b>Volume</b></label>
            <div className="sounds-volume">
              <input id="sounds-volume" type="range" min={0} max={100} step={5} value={Math.round(shown * 100)} disabled={!sounds.enabled}
                aria-valuetext={`${Math.round(shown * 100)} percent`} onChange={(e) => onVolume(Number(e.target.value) / 100)} />
              <output htmlFor="sounds-volume">{Math.round(shown * 100)}%</output>
            </div>
          </div>

          <fieldset className="snd-packs" disabled={!sounds.enabled}>
            <legend>Sound pack</legend>
            <ul className="snd-featured">{packs.filter((p) => p.custom).map((p) => card(p, true))}</ul>
            <p className="snd-sub">More packs</p>
            <ul className="snd-library">{packs.filter((p) => !p.custom).map((p) => card(p, false))}</ul>
            <p className="set-hint">Playing a sample plays three sounds: something needs you, Allow, and a run finished.</p>
          </fieldset>

          <div className="snd-events">
            <button type="button" className="snd-toggle" aria-expanded={open} aria-controls="snd-events-panel" onClick={() => setOpen(!open)}>
              <svg className="snd-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
              <span>Choose sounds for each event</span>
              {changedCount > 0 && <span className="snd-count">{changedCount} changed</span>}
            </button>
            {open && (
              <fieldset id="snd-events-panel" className="snd-rows" disabled={!sounds.enabled}>
                <legend className="sr-only">Sound for each event</legend>
                <p className="set-hint">Each event plays its sound from the pack above unless you change it here. Changing the pack moves every event you have not changed.</p>
                <ul>
                  {EVENT_ROWS.map((r) => {
                    const c = events[r.key];
                    const on = c?.enabled ?? eventDefaultOn(r.key);
                    const own = resolveEvent(SAMPLE[r.key], { ...prefs, events: { ...events, [r.key]: { ...c, enabled: true } } });
                    const cur = valueOf(c);
                    const listed = !c?.sound || groups.some((g) => g.pack === c.sound!.pack && g.cues.some((q) => q.id === c.sound!.cue));
                    return (
                      <li key={r.key} className={`snd-row${c ? ' changed' : ''}`}>
                        <div className="snd-name">
                          <span className="snd-title"><b>{r.label}</b>{c && <><i className="snd-dot" aria-hidden="true" /><span className="sr-only">, changed from the default</span></>}</span>
                          <span className="snd-h">{r.hint}{c && <> <button type="button" className="snd-reset" aria-label={`Reset: ${r.label}`} onClick={() => change(r.key, { enabled: eventDefaultOn(r.key), sound: null })}>Reset</button></>}</span>
                        </div>
                        <select className="snd-pick" aria-label={`Sound choice for: ${r.label}`} disabled={!on} value={cur}
                          onChange={(e) => { const v = e.target.value; if (!v) change(r.key, { sound: null }); else { const i = v.indexOf('/'); change(r.key, { sound: { pack: v.slice(0, i), cue: v.slice(i + 1) } }); } }}>
                          <option value="">Pack sound ({packLabel})</option>
                          {!listed && c?.sound && <option value={cur}>{packs.find((p) => p.id === c.sound!.pack)?.label ?? c.sound.pack}: {cueRole(c.sound.cue)}</option>}
                          {groups.map((g) => (
                            <optgroup key={g.pack} label={g.label}>
                              {g.cues.map((q) => <option key={q.id} value={`${g.pack}/${q.id}`}>{q.label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                        <button type="button" className="btn sm snd-play" disabled={!on || !own} aria-label={`Play: ${r.label}`} onClick={() => own && previewSound(own.pack, own.cue, shown)}>Play</button>
                        <span className="snd-sw"><Switch id={`snd-sw-${r.key}`} on={on} label={`Sound for: ${r.label}`} onChange={(v) => change(r.key, { enabled: v })} /></span>
                      </li>
                    );
                  })}
                </ul>
                <div className="snd-foot">
                  <span className="snd-legend"><i className="snd-dot" aria-hidden="true" /> Changed from the default</span>
                  <button type="button" className="btn sm" disabled={changedCount === 0} onClick={() => void patch({ events: null })}>Reset all to the pack</button>
                </div>
              </fieldset>
            )}
          </div>
        </>
      )}
    </div>
  );
}
