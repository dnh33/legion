import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { errText } from '../store';
import type { BrowserCheckResult, BrowserStatusView } from '../../../src/shared/browser';
import './browser.css';

/** Settings: the browser tool (headless Edge or Chrome already on this computer). All text from the core is shown as plain text. */
export function BrowserSection() {
  const [st, setSt] = useState<BrowserStatusView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [check, setCheck] = useState<BrowserCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState('');
  const [path, setPath] = useState('');
  const [ports, setPorts] = useState('');
  const load = useCallback(async () => {
    try { const s = await request<BrowserStatusView>('GET', '/api/browser'); setSt(s); setDomains((d) => d || s.allowDomains.join(', ')); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); void load(); } };
  // The browser program and local-address changes go through the app window's native confirmation (the window never holds the secret).
  const native = (change: Record<string, unknown>) => act(async () => {
    const fn = (window as unknown as { legion?: { browserChange?: (c: unknown) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }> } }).legion?.browserChange;
    if (!fn) throw new Error('This needs the Legion app window (it shows a confirmation dialog). Open Legion from its shortcut.');
    const r = await fn(change);
    if (r.cancelled) setNote('Cancelled. Nothing changed.'); else if (!r.ok) throw new Error(r.error ?? 'The change failed.');
  });
  const save = (patch: Record<string, unknown>) => act(async () => { setSt(await request<BrowserStatusView>('POST', '/api/browser/config', patch)); });
  if (!st) return <div className="brw">{err ? <p className="brw-err" role="alert">{err}</p> : <p className="brw-muted">Loading{'…'}</p>}</div>;
  const b = st.browser;
  return (
    <div className="brw" aria-label="Browser">
      <h4>Browser</h4>
      <p className="brw-muted">Lets agents read web pages as text. It uses Microsoft Edge or Google Chrome, already on this computer, in a hidden window: nothing is downloaded. It does not draw pages for you or take screenshots. Every page is treated as untrusted text; the first page, each new site and each script ask you first. The browser runs with your user rights: a cloud VM is the only isolated way to browse (use the VM live view for that).</p>
      <label className="brw-row"><input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} /> Let agents browse the web {st.enabled ? '(on)' : '(off)'}</label>
      <ul className="brw-engines" aria-label="Browser engine">
        {st.engines.map((e) => <li key={e.id}><b>Engine:</b> {e.label}</li>)}
      </ul>
      <p className={b && !b.tooOld ? 'brw-muted' : 'brw-err'} role="status">
        {b ? `Browser: ${b.name}${b.version ? ` ${b.version}` : ' (version unknown)'} at ${b.path}${b.tooOld ? ' (too old for headless mode: update it)' : ''}.` : `No Edge or Chrome found: install one or set a path. Looked in: ${st.tried.slice(0, 3).join('; ')}.`}
      </p>
      <p className="brw-muted">{st.lastRun ? `Last run: ${st.lastRun.at.replace('T', ' ').slice(0, 19)}, ${st.lastRun.ok ? 'worked' : 'failed'}${st.lastRun.browser ? ` (${st.lastRun.browser})` : ''}. ${st.lastRun.ok ? '' : st.lastRun.note}` : 'Last run: never.'} Running now: {st.running}.</p>
      <div className="brw-actions">
        <button type="button" className="btn-ghost sm" disabled={busy || !b} onClick={() => void act(async () => { const r = await request<{ result: BrowserCheckResult; status: BrowserStatusView }>('POST', '/api/browser/check'); setCheck(r.result); setSt(r.status); })}>Open test page</button>
        <span className="brw-muted">Starts the browser once and loads a harmless page that Legion itself provides (no network).</span>
      </div>
      {check && (
        <ul className="brw-check" role="status" aria-label="Test page result">
          {check.steps.map((s) => <li key={s.step} className={s.ok ? 'brw-ok' : 'brw-err'}>{s.ok ? 'OK' : 'Failed'}: {s.detail}</li>)}
        </ul>
      )}
      <div className="brw-row">
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={st.chosenPath ?? 'Path to msedge.exe, chrome.exe or brave.exe (optional)'} aria-label="Browser path" spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={busy || !path.trim()} title="Asks you to confirm in a dialog" onClick={() => void native({ kind: 'chromium', path: path.trim() }).then(() => setPath(''))}>Use this browser</button>
        {st.chosenPath && <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void native({ kind: 'chromium', path: null })}>Automatic</button>}
      </div>
      <div className="brw-row">
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="Only these sites (optional): example.com, docs.org" aria-label="Allowed sites" spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void save({ allowDomains: domains.split(/[\s,]+/).filter(Boolean) })}>Save sites</button>
      </div>
      <div className="brw-row">
        <input value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="Local ports to allow (optional), e.g. 8080, 3000" aria-label="Local ports" spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={busy || !ports.trim()} onClick={() => void native({ kind: 'local', allow: true, ports: ports.split(/[\s,]+/).filter(Boolean).map(Number) })}>Allow local addresses (until restart)</button>
        {st.allowLocal && <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void native({ kind: 'local', allow: false })}>Turn off</button>}
      </div>
      <p className="brw-muted">Not protected: anything else on this computer can reach the browser's local debugging port while a task runs; the browser can resolve a name differently from Legion's check; sockets and WebRTC a page opens are not claimed to be checked.</p>
      {note && <p className="brw-note" role="status">{note}</p>}
      {err && <p className="brw-err" role="alert">{err}</p>}
    </div>
  );
}
