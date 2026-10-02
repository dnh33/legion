import { useCallback, useEffect, useState } from 'react';
import { request } from '../api';
import { errText } from '../store';
import type { BrowserStatusView } from '../../../src/shared/browser';
import './browser.css';

interface GetResult { ok: boolean; steps: Array<{ step: string; ok: boolean; detail: string }>; status: BrowserStatusView }

/** Settings: the browser tool (Lightpanda). All text from the core is shown as plain text. */
export function BrowserSection() {
  const [st, setSt] = useState<BrowserStatusView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState('');
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('');
  const load = useCallback(async () => {
    try { const s = await request<BrowserStatusView>('GET', '/api/browser'); setSt(s); setDomains((d) => d || s.allowDomains.join(', ')); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setNote(null); try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); void load(); } };
  const save = (patch: Record<string, unknown>) => act(async () => { setSt(await request<BrowserStatusView>('POST', '/api/browser/config', patch)); });
  if (!st) return <div className="brw">{err ? <p className="brw-err" role="alert">{err}</p> : <p className="brw-muted">Loading{'…'}</p>}</div>;
  return (
    <div className="brw" aria-label="Browser">
      <h4>Browser (Lightpanda)</h4>
      <p className="brw-muted">Lets agents read web pages as text without a VM, using Lightpanda, a small separate program (AGPL-3.0; Legion does not include it). It runs on this computer for one task at a time. It does not draw pages or take screenshots. Every page is treated as untrusted text; the first page and each new site ask you first.</p>
      <label className="brw-row"><input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} /> Let agents browse the web {st.enabled ? '(on)' : '(off)'}</label>
      <p className="brw-muted">{st.note}</p>
      <p className="brw-muted">Program: {st.binary === 'none' ? 'not set up' : `${st.binary === 'managed' ? 'fetched by Legion' : 'your own'} ${st.binaryPath ?? ''}`}. Browsers running now: {st.running}. Local addresses: {st.allowLocal ? 'allowed on listed ports until restart' : 'refused'}.</p>
      {st.pin && !st.needsLauncher && (
        <div className="brw-actions">
          <button type="button" className="btn-ghost sm" disabled={busy || st.getting || !st.pin.sha256Known} onClick={() => void act(async () => { const r = await request<GetResult>('POST', '/api/browser/get'); setNote(r.steps.map((s) => s.detail).join(' ')); })}>Get Lightpanda for Legion (about {st.pin.approxMb} MB, you approve first)</button>
          {!st.pin.sha256Known && <span className="brw-muted">No hash is recorded for this build yet, so Legion will not download it. You can point to your own copy below.</span>}
        </div>
      )}
      {st.needsLauncher && <p className="brw-muted">Lightpanda has no Windows build. Install it inside WSL, then enter <code>wsl.exe</code> below with arguments such as <code>-e /home/you/lightpanda</code>.</p>}
      <div className="brw-row">
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={st.binaryPath ?? 'Path to lightpanda (or wsl.exe)'} aria-label="Program path" spellCheck={false} />
        <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="Launcher arguments (optional), space separated" aria-label="Launcher arguments" spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={busy || !path.trim()} onClick={() => void save({ binaryPath: path.trim(), launcherArgs: args.trim() ? args.trim().split(/\s+/) : [] }).then(() => setPath(''))}>Use this program</button>
        <button type="button" className="btn-ghost sm" disabled={busy || st.binary === 'none'} onClick={() => void act(async () => { const r = await request<{ ok: boolean; detail: string }>('POST', '/api/browser/test'); setNote(r.detail); })}>Test</button>
      </div>
      <div className="brw-row">
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="Only these sites (optional): example.com, docs.org" aria-label="Allowed sites" spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => void save({ allowDomains: domains.split(/[\s,]+/).filter(Boolean) })}>Save sites</button>
      </div>
      <p className="brw-muted">Not protected: anything else on this computer can reach the browser's local port while a task runs; a page's own scripts run inside Lightpanda; Legion cannot stop a redirect or page request to a public site the browser makes itself.</p>
      {note && <p className="brw-note" role="status">{note}</p>}
      {err && <p className="brw-err" role="alert">{err}</p>}
    </div>
  );
}
