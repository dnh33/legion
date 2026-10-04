import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerEntry, McpStatusView, SettingsPatch, SettingsView } from '../../../src/shared/types';
import { api, base, openExternal, token } from '../api';
import { checkBoat, ensureBoatChecked, closeSettings, decide, errText, loadSettings, saveSettings, setSettingsSection as setSection, toast, useStore, type SettingsSection } from '../store';
import { copyText } from '../util';
import { BLENDER_LICENSE_NOTE, GET_BLENDER_TOOL } from '../../../src/shared/blender';
import { ASSETS_TEXT, ASSETS_TITLE, BOTH_TEXT, BOTH_TITLE, FULL_BLENDER_TEXT, GET_BLENDER_NOT_PINNED, GET_BLENDER_TEXT, LOCAL_SAFETY_NOTE, MODE_CHOICES, NOT_TRIED_LOCAL, NOT_TRIED_VM, visibleNotices } from '../blender/copy';
import { lightLabel, loadBlender, runBlenderGet, runBlenderLaunch, runBlenderSetup, requestEnableBlender, runBlenderTest, saveBlenderConfig, useBlender } from '../blender/blenderStore';
import '../blender/blender.css';
import { ProvidersSection } from '../providers/ProvidersSection';
import { loadProviders, useProviders } from '../providers/providersStore';
import { Icon } from './icons';
import { UpdatePanel } from './UpdatePanel';
import { BrowserSection } from '../browser/BrowserSection';
import { HouseSection } from '../house/HouseSection';

const NAV: { id: SettingsSection; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude', hint: 'Sign-in, key, runs' },
  { id: 'providers', label: 'Providers', hint: 'Other models, optional' },
  { id: 'boat', label: 'boat.dev (VMs)', hint: 'Cloud computers' },
  { id: 'mcp', label: 'MCP servers', hint: 'Extra tools for agents' },
  { id: 'blender', label: 'Blender', hint: 'Build 3D with the Sculptor' },
  { id: 'house', label: 'House context', hint: 'What your agents read as rules' },
  { id: 'connections', label: 'Connections', hint: 'Use Legion from Claude' },
  { id: 'about', label: 'About', hint: 'Version and folders' },
];

export function SettingsPanel() {
  const section = useStore((s) => s.settingsSection);
  const settings = useStore((s) => s.settings);
  useEffect(() => { if (!settings) void loadSettings(); }, []);
  // Providers ship (OpenRouter on by default); the tab shows only when the core serves the provider routes (config.json features.providers)
  const provView = useProviders((x) => x.view);
  useEffect(() => { void loadProviders(); }, []);
  const nav = provView ? NAV : NAV.filter((n) => n.id !== 'providers');
  return (
    <section className="settings" aria-label="Settings">
      <nav className="set-nav" aria-label="Settings sections">
        <button className="set-back" onClick={closeSettings} aria-label="Back to chat" title="Back to chat (Esc)"><Icon name="chevron" size={13} /> <span>Back to chat</span></button>
        <h2>Settings</h2>
        {nav.map((n) => (
          <button key={n.id} className={`set-link${section === n.id ? ' sel' : ''}`} aria-current={section === n.id} onClick={() => setSection(n.id)}>
            <b>{n.label}</b><span>{n.hint}</span>
          </button>
        ))}
      </nav>
      <div className="set-scroll scroll-cue">
        <div className="set-body">
          {!settings ? <div className="set-loading"><span className="spin" /> Loading settings{'…'}</div> : (
            section === 'claude' ? <ClaudeSection s={settings} />
              : section === 'providers' ? <ProvidersSection />
              : section === 'boat' ? <BoatSection s={settings} />
                : section === 'mcp' ? <McpSection s={settings} />
                  : section === 'blender' ? <BlenderSection />
                    : section === 'house' ? <HouseSection />
                  : section === 'connections' ? <ConnectionsSection s={settings} />
                    : <AboutSection s={settings} />
          )}
        </div>
      </div>
    </section>
  );
}

function Head({ title, lead }: { title: string; lead: ReactNode }) { return <header className="set-head"><h3>{title}</h3><p>{lead}</p></header>; }
function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return <label className="set-field" htmlFor={id}><span className="set-label">{label}</span>{children}{hint && <span className="set-hint">{hint}</span>}</label>;
}
function SaveBar({ dirty, busy, error, onSave, onReset, label = 'Save' }: { dirty: boolean; busy: boolean; error: string | null; onSave: () => void; onReset?: () => void; label?: string }) {
  return (
    <div className="set-savebar">
      {error && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>}
      <div className="set-actions">
        {onReset && dirty && <button type="button" className="btn-ghost" onClick={onReset} disabled={busy}>Discard</button>}
        <button type="button" className="btn primary" onClick={onSave} disabled={!dirty || busy}>{busy ? 'Saving…' : label}</button>
      </div>
    </div>
  );
}
const keyNote = (set: boolean, hint?: string) => (set ? `set \u00b7 ${hint ?? '\u2026'}` : 'not set');

/* ---------------- Claude ---------------- */
function ClaudeSection({ s }: { s: SettingsView }) {
  const c = s.claude;
  const [auth, setAuth] = useState(c.auth);
  const [key, setKey] = useState('');
  const [exec, setExec] = useState(c.executablePath ?? '');
  const [inherit, setInherit] = useState(c.inheritClaudeCodeSettings);
  const [inheritMcp, setInheritMcp] = useState(c.inheritMcp);
  const [turns, setTurns] = useState(String(c.maxTurns));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRm, setConfirmRm] = useState(false);
  const reset = () => { setAuth(c.auth); setKey(''); setExec(c.executablePath ?? ''); setInherit(c.inheritClaudeCodeSettings); setInheritMcp(c.inheritMcp); setTurns(String(c.maxTurns)); setError(null); };
  useEffect(reset, [JSON.stringify(c)]);
  const dirty = auth !== c.auth || key !== '' || exec !== (c.executablePath ?? '') || inherit !== c.inheritClaudeCodeSettings || inheritMcp !== c.inheritMcp || turns !== String(c.maxTurns);

  const save = async () => {
    const n = Number(turns);
    if (!Number.isInteger(n) || n < 1 || n > 1000) { setError('Max turns must be a whole number between 1 and 1000.'); return; }
    if (auth === 'api-key' && !key && !c.apiKeySet) { setError('Paste an Anthropic API key to use API key mode.'); return; }
    setBusy(true); setError(null);
    const patch: SettingsPatch = { claude: { auth, inheritClaudeCodeSettings: inherit, inheritMcp, maxTurns: n, executablePath: exec.trim() || null, ...(key ? { apiKey: key.trim() } : {}) } };
    try { await saveSettings(patch); setKey(''); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const removeKey = async () => {
    setBusy(true); setError(null);
    try { await saveSettings({ claude: { apiKey: null, ...(auth === 'api-key' ? { auth: 'claude-login' as const } : {}) } }); setConfirmRm(false); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };

  return (
    <div className="set-section">
      <Head title="Claude" lead="How agents sign in and how long a run may go. Changes apply from the next run." />
      <div className="set-card">
        <div className="set-field"><span className="set-label">Sign in with</span>
          <div className="seg" role="radiogroup" aria-label="Sign-in mode">
            <button type="button" role="radio" aria-checked={auth === 'claude-login'} className={auth === 'claude-login' ? 'on' : ''} onClick={() => setAuth('claude-login')}>Claude sign-in</button>
            <button type="button" role="radio" aria-checked={auth === 'api-key'} className={auth === 'api-key' ? 'on' : ''} onClick={() => setAuth('api-key')}>API key</button>
          </div>
          <span className="set-hint">{auth === 'claude-login' ? 'Uses the account you are signed into Claude Code with. Covered by your subscription.' : 'Bills your Anthropic API account per token.'}</span>
        </div>
        <Field id="claude-key" label="Anthropic API key" hint={<>Status: <b>{keyNote(c.apiKeySet, c.apiKeyHint)}</b>. The key is stored in your config file and never shown again.</>}>
          <div className="set-inline">
            <input id="claude-key" type="password" autoComplete="off" spellCheck={false} value={key} disabled={auth !== 'api-key'} onChange={(e) => setKey(e.target.value)}
              placeholder={c.apiKeySet ? `set \u00b7 ${c.apiKeyHint ?? ''} (paste to replace)` : 'sk-ant-\u2026'} />
            {c.apiKeySet && (confirmRm
              ? <><button type="button" className="btn danger" onClick={() => void removeKey()} disabled={busy}>Remove</button><button type="button" className="btn-ghost" onClick={() => setConfirmRm(false)}>Keep</button></>
              : <button type="button" className="btn-ghost" onClick={() => setConfirmRm(true)}>Remove key</button>)}
          </div>
        </Field>
        <Field id="claude-exec" label="Claude executable" hint="Leave empty to find `claude` on your PATH.">
          <input id="claude-exec" value={exec} onChange={(e) => setExec(e.target.value)} placeholder="C:\Users\you\AppData\Roaming\npm\claude.cmd" spellCheck={false} />
        </Field>
        <Field id="claude-turns" label="Max turns per run" hint="Stops a run that loops. 1 to 1000.">
          <input id="claude-turns" className="narrow" inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <label className="set-check"><input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
          <span><b>Inherit my Claude Code settings</b><em>Agents also read your user and project settings, hooks and CLAUDE.md, like Claude Code in a terminal. The MCP choice below is separate and applies whichever way this is set.</em></span></label>
        <label className="set-check"><input type="checkbox" checked={inheritMcp} onChange={(e) => setInheritMcp(e.target.checked)} />
          <span><b>Also load MCP servers and claude.ai connectors from my Claude Code setup</b><em>Off by default. When off, Legion asks Claude Code to use only Legion's own tools and the servers you add under MCP servers, and not to load claude.ai connectors. Turning it on brings back the servers and connectors you use in Claude Code, which connect again on every run. This only changes what Legion's own code asks Claude Code to load; it does not limit what an agent's ordinary tools, such as a shell, can reach.</em></span></label>
      </div>
      <SaveBar dirty={dirty} busy={busy} error={error} onSave={() => void save()} onReset={reset} />
    </div>
  );
}

/* ---------------- boat.dev ---------------- */
type BoatStatus = { kind: 'checking' | 'ok' | 'bad' | 'none'; detail?: string };
const rateText = (n?: number) => (typeof n === 'number' ? String(n) : '');
function BoatSection({ s }: { s: SettingsView }) {
  const b = s.boat;
  const health = useStore((st) => st.boatHealth);
  const [rates, setRates] = useState({ small: rateText(b.rates.small), default: rateText(b.rates.default), large: rateText(b.rates.large) });
  const [currency, setCurrency] = useState(b.currency);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (b.apiKeySet) void ensureBoatChecked(); }, [b.apiKeySet]);
  useEffect(() => { setRates({ small: rateText(b.rates.small), default: rateText(b.rates.default), large: rateText(b.rates.large) }); setCurrency(b.currency); }, [b.rates.small, b.rates.default, b.rates.large, b.currency]);
  const ratesDirty = rates.small !== rateText(b.rates.small) || rates.default !== rateText(b.rates.default) || rates.large !== rateText(b.rates.large) || currency !== b.currency;
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [url, setUrl] = useState(b.baseUrl);
  const [status, setStatus] = useState<BoatStatus>(b.apiKeySet ? { kind: 'checking' } : { kind: 'none' });
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRm, setConfirmRm] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string; warnings?: string[] } | null>(null);

  const check = async (k?: string) => {
    setTesting(true);
    try { const r = await api.testBoat(k, url.trim() || undefined); if (!k) setStatus({ kind: r.ok ? 'ok' : 'bad', detail: r.detail }); setTestNote({ ok: r.ok, text: r.detail, warnings: r.warnings }); return r; }
    catch (e) { setTestNote({ ok: false, text: errText(e) }); if (!k) setStatus({ kind: 'bad', detail: errText(e) }); return null; }
    finally { setTesting(false); }
  };
  useEffect(() => { if (b.apiKeySet) { setStatus({ kind: 'checking' }); void check(); } else setStatus({ kind: 'none' }); }, [b.apiKeySet, b.apiKeyHint]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const patch: SettingsPatch = { boat: { ...(key.trim() ? { apiKey: key.trim() } : {}), ...(url !== b.baseUrl ? { baseUrl: url.trim() } : {}) } };
      if (ratesDirty) {
        const num = (t: string): number | null => (t.trim() === '' ? null : Number(t.replace(',', '.')));
        const r = { small: num(rates.small), default: num(rates.default), large: num(rates.large) };
        if (Object.values(r).some((v) => v !== null && !(Number.isFinite(v) && v > 0))) throw new Error('Hourly prices must be positive numbers, or empty for no estimate.');
        patch.boat = { ...patch.boat, rates: r, currency: currency.trim() };
      }
      await saveSettings(patch); setKey(''); setTestNote(null);
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await saveSettings({ boat: { apiKey: null } }); setConfirmRm(false); setTestNote(null); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const dirty = key.trim() !== '' || url !== b.baseUrl || ratesDirty;
  const recheck = async () => { setChecking(true); await checkBoat(); setChecking(false); };
  const line = status.kind === 'ok' ? `Connected \u00b7 key ${b.apiKeyHint ?? ''}` : status.kind === 'checking' ? 'Checking the saved key\u2026' : status.kind === 'bad' ? `Key ${b.apiKeyHint ?? ''} saved, but boat.dev did not accept it` : 'Not set up';

  return (
    <div className="set-section">
      <Head title="boat.dev (VMs)" lead="Agents can start a cloud computer on demand and stop it when idle. Legion needs your boat.dev API key to do that." />
      <div className="set-card">
        <div className={`set-status st-${status.kind}`} role="status">
          <i className="set-dot" /><b>{line}</b>
          {status.kind === 'bad' && status.detail && <span className="muted-s">{status.detail}</span>}
          {b.apiKeySet && <button type="button" className="link-btn" onClick={() => void check()} disabled={testing}>{testing ? 'Testing\u2026' : 'Test again'}</button>}
        </div>
        <Field id="boat-key" label={b.apiKeySet ? 'Replace key' : 'API key'} hint={<>Get a key at <button type="button" className="link-btn" onClick={() => openExternal('https://boat.dev/')}>boat.dev</button>. Stored in your config file; Legion never shows it back.</>}>
          <div className="set-inline">
            <input id="boat-key" type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setTestNote(null); }}
              placeholder={b.apiKeySet ? `set \u00b7 ${b.apiKeyHint ?? ''} (paste to replace)` : 'Paste your boat.dev key'} />
            <button type="button" className="icon-btn" aria-label={show ? 'Hide key' : 'Show key'} title={show ? 'Hide key' : 'Show key'} onClick={() => setShow((v) => !v)}><Icon name="eye" size={15} /></button>
            <button type="button" className="btn" onClick={() => void check(key.trim() || undefined)} disabled={testing || (!key.trim() && !b.apiKeySet)}>{testing ? 'Testing\u2026' : 'Test'}</button>
          </div>
        </Field>
        {testNote && <div className={`set-test ${testNote.ok ? 'ok' : 'bad'}`} role="status"><Icon name={testNote.ok ? 'check' : 'x'} size={13} /> {testNote.text}{key.trim() ? (testNote.ok ? ' Press Save to keep it.' : '') : ''}</div>}
        {key.trim() && testNote?.warnings?.map((w) => <div key={w} className="set-test warn" role="status"><Icon name="shield" size={13} /> {w}</div>)}
        {b.apiKeySet && (
          <div className="set-perms" aria-label="What this key can do">
            <div className="set-perms-head"><b>Key permissions</b>
              <button type="button" className="link-btn" onClick={() => void recheck()} disabled={checking}>{checking ? 'Checking\u2026' : health?.checkedAt ? 'Check again' : 'Check now'}</button>
            </div>
            {!health?.checkedAt && <p className="muted-s">Not checked yet. Checking only reads and asks about a VM that does not exist; it never creates one.</p>}
            {health?.keyProblem && (
              <p className="set-perm warn"><Icon name="shield" size={13} /> <span>{health.keyProblem.kind === 'auth' ? 'boat.dev rejected this key.' : `Could not check the key (${{ network: 'cannot reach boat.dev', rate_limit: 'boat.dev is rate limiting', server: 'boat.dev had a server error', other: 'unexpected answer' }[health.keyProblem.kind]}). That says nothing about the key; try again later.`}</span></p>
            )}
            {health?.forbidden.map((f) => (
              <p key={f.action} className="set-perm bad"><Icon name="x" size={13} /> <span>This key cannot <code>{f.action}</code>. Create a full-access key in boat.dev and paste it above.</span></p>
            ))}
            {health?.checkedAt && health.forbidden.length === 0 && !health.keyProblem && (
              <p className="set-perm ok"><Icon name="check" size={13} /> <span>boat.dev did not refuse any action at the last check ({new Date(health.checkedAt).toLocaleTimeString()}). A real call can still be refused; if so, it shows up here.</span></p>
            )}
            {health?.claude.state === 'not_configured' && (
              <p className="set-perm warn"><Icon name="shield" size={13} /> <span>Claude is not configured on boat.dev: open the <button type="button" className="link-btn" onClick={() => openExternal('https://boat.dev/')}>Agents page</button> in your dashboard. Until then the vm_claude tool is off.</span></p>
            )}
            {health?.trial.limited && (
              <p className="set-perm warn"><Icon name="shield" size={13} /> <span>Free trial: the Large VM size is not available. Agents set to Large use Default instead.</span></p>
            )}
          </div>
        )}
        <div className="set-rates">
          <div className="set-label">Cost estimate (optional)</div>
          <div className="set-hint">Legion shows how long a VM ran. To also see an estimate, type your hourly price per size from your boat.dev plan. Leave empty for none. Legion never assumes a price.</div>
          <div className="set-inline">
            {(['small', 'default', 'large'] as const).map((k) => (
              <label key={k} className="set-rate"><span>{k[0]!.toUpperCase() + k.slice(1)} / hour</span>
                <input inputMode="decimal" value={rates[k]} onChange={(e) => setRates((r) => ({ ...r, [k]: e.target.value }))} placeholder="none" spellCheck={false} /></label>
            ))}
            <label className="set-rate"><span>Currency</span><input value={currency} maxLength={12} onChange={(e) => setCurrency(e.target.value)} placeholder="e.g. USD" spellCheck={false} /></label>
          </div>
        </div>
        <details className="set-adv">
          <summary>Advanced</summary>
          <Field id="boat-url" label="API base URL" hint="Only change this for a self-hosted or staging boat.dev."><input id="boat-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} /></Field>
        </details>
      </div>
      <div className="set-savebar-row">
        <div className="set-remove">
          {b.apiKeySet && (confirmRm
            ? <><span className="muted-s">Remove the key? VMs stop working until you add one.</span><button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>Yes, remove</button><button type="button" className="btn-ghost" onClick={() => setConfirmRm(false)}>Keep</button></>
            : <button type="button" className="btn-ghost danger" onClick={() => setConfirmRm(true)}><Icon name="trash" size={13} /> Remove key</button>)}
        </div>
        <SaveBar dirty={dirty} busy={busy} error={error} onSave={() => void save()} onReset={() => { setKey(''); setUrl(b.baseUrl); setRates({ small: rateText(b.rates.small), default: rateText(b.rates.default), large: rateText(b.rates.large) }); setCurrency(b.currency); setError(null); setTestNote(null); }} />
      </div>
    </div>
  );
}

/* ---------------- MCP servers ---------------- */
interface Kv { k: string; v: string; masked?: string }
const MASK = '\u2022\u2022\u2022\u2022';
const toKv = (o?: Record<string, string>): Kv[] => Object.entries(o ?? {}).map(([k, v]) => (v.startsWith(MASK) ? { k, v: '', masked: v } : { k, v }));
interface Draft { orig: string | null; name: string; type: 'stdio' | 'http' | 'sse'; command: string; args: string; env: Kv[]; url: string; headers: Kv[] }
const toDraft = (name: string | null, e?: McpServerEntry): Draft => {
  if (!e) return { orig: null, name: '', type: 'stdio', command: '', args: '', env: [], url: '', headers: [] };
  if (e.type === 'http' || e.type === 'sse') return { orig: name, name: name ?? '', type: e.type, command: '', args: '', env: [], url: e.url, headers: toKv(e.headers) };
  return { orig: name, name: name ?? '', type: 'stdio', command: e.command, args: (e.args ?? []).join('\n'), env: toKv(e.env), url: '', headers: [] };
};
function fromDraft(d: Draft, taken: string[]): { entry?: McpServerEntry; error?: string } {
  const name = d.name.trim();
  if (!name) return { error: 'Give the server a name.' };
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: 'The name may only use letters, numbers, - and _.' };
  if (name !== d.orig && taken.includes(name)) return { error: `There is already a server called "${name}".` };
  const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (d.type === 'stdio') {
    if (!d.command.trim()) return { error: 'Enter the command that starts the server.' };
    const env: Record<string, string> = {};
    for (const r of d.env) { if (!r.k.trim() && !r.v && !r.masked) continue; if (!r.k.trim()) return { error: 'Every environment variable needs a name.' }; env[r.k.trim()] = !r.v && r.masked ? r.masked : r.v; }
    const args = lines(d.args);
    return { entry: { type: 'stdio', command: d.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) } };
  }
  if (!/^https?:\/\/\S+$/.test(d.url.trim())) return { error: 'The URL must start with http:// or https://.' };
  const headers: Record<string, string> = {};
  for (const r of d.headers) { if (!r.k.trim() && !r.v && !r.masked) continue; if (!r.k.trim()) return { error: 'Every header needs a name.' }; headers[r.k.trim()] = !r.v && r.masked ? r.masked : r.v; }
  return { entry: { type: d.type, url: d.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) } };
}
const summary = (e: McpServerEntry) => (e.type === 'http' || e.type === 'sse' ? e.url : [e.command, ...(e.args ?? [])].join(' '));

function KvEditor({ label, hint, rows, onChange, keyPh }: { label: string; hint: string; rows: Kv[]; onChange: (r: Kv[]) => void; keyPh: string }) {
  const upd = (i: number, p: Partial<Kv>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...p } : r)));
  return (
    <div className="set-field"><span className="set-label">{label}</span>
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input value={r.k} onChange={(e) => upd(i, { k: e.target.value })} placeholder={keyPh} spellCheck={false} aria-label={`${label} name`} />
          <input type={r.masked && !r.v ? 'text' : 'password'} className={r.masked && !r.v ? 'is-masked' : ''} value={r.v} onChange={(e) => upd(i, { v: e.target.value })} autoComplete="off" spellCheck={false}
            placeholder={r.masked ? `${r.masked}  \u00b7 unchanged` : 'value'} aria-label={`${label} value`} />
          <button type="button" className="icon-btn sm" aria-label="Remove" onClick={() => onChange(rows.filter((_, n) => n !== i))}><Icon name="x" size={12} /></button>
        </div>
      ))}
      <button type="button" className="btn-ghost sm kv-add" onClick={() => onChange([...rows, { k: '', v: '' }])}><Icon name="plus" size={12} /> Add</button>
      <span className="set-hint">{hint}</span>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  connected: 'Connected', failed: 'Failed', 'needs-auth': 'Needs sign-in', pending: 'Connecting', disabled: 'Off', 'not-seen': 'Not used yet', unknown: 'Unknown',
};
/** Read-only: what the Claude Code process reported for each server on the latest run. It never connects or changes anything. */
function McpStatus({ s }: { s: SettingsView }) {
  const [st, setSt] = useState<McpStatusView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { api.mcpStatus().then((v) => { setSt(v); setErr(null); }).catch((e) => setErr(errText(e))); };
  useEffect(load, [JSON.stringify(s.claude.inheritMcp)]);
  return (
    <div className="set-card mcp-status">
      <div className="set-field"><span className="set-label">Status on the most recent run</span>
        <span className="set-hint">{s.claude.inheritMcp ? 'Servers from your Claude Code setup are included.' : 'Legion asks Claude Code to load only its own tools and the servers below.'} Read-only; it shows the most recent run only, and updates when an agent starts a run, so with several agents running it is whichever started last.</span>
        {st?.notice && <span className="set-hint" role="status">{st.notice}</span>}
        {err && <span className="set-hint" role="alert">Could not read the status: {err}</span>}
        <ul className="mcp-list">
          {(st?.servers ?? []).map((v) => (
            <li key={v.name}>
              <span className="mcp-type">{STATE_LABEL[v.state] ?? v.state}</span>
              <div className="mcp-main"><b>{v.name}</b><code>{v.origin}</code><span className="muted-s">{v.message}</span></div>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-ghost sm" onClick={load}>Refresh</button>
      </div>
    </div>
  );
}

function McpSection({ s }: { s: SettingsView }) {
  const entries = Object.entries(s.mcpServers);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rm, setRm] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const write = async (map: Record<string, McpServerEntry>) => {
    setBusy(true); setError(null);
    try { await saveSettings({ mcpServers: map }); return true; } catch (e) { setError(errText(e)); return false; } finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft) return;
    const r = fromDraft(draft, Object.keys(s.mcpServers));
    if (!r.entry) { setError(r.error ?? 'Check the fields.'); return; }
    const map: Record<string, McpServerEntry> = {};
    for (const [k, v] of entries) if (k !== draft.orig) map[k] = v;
    map[draft.name.trim()] = r.entry;
    if (await write(map)) setDraft(null);
  };
  const remove = async (name: string) => {
    const map: Record<string, McpServerEntry> = {}; for (const [k, v] of entries) if (k !== name) map[k] = v;
    if (await write(map)) setRm(null);
  };

  return (
    <div className="set-section">
      <Head title="MCP servers" lead="Extra tools your agents can use, same format as Claude Code. Agents pick these up on their next run." />
      {entries.length === 0 && !draft && <div className="set-empty"><b>No servers yet.</b><span>Add one to give agents tools like GitHub, a database or a docs search.</span></div>}
      {entries.length > 0 && (
        <ul className="mcp-list">
          {entries.map(([name, e]) => (
            <li key={name} className={draft?.orig === name ? 'editing' : ''}>
              <span className="mcp-type">{e.type ?? 'stdio'}</span>
              <div className="mcp-main"><b>{name}</b><code title={summary(e)}>{summary(e)}</code></div>
              {rm === name
                ? <div className="mcp-actions"><span className="muted-s">Remove?</span><button type="button" className="btn danger sm" onClick={() => void remove(name)} disabled={busy}>Yes</button><button type="button" className="btn-ghost sm" onClick={() => setRm(null)}>No</button></div>
                : <div className="mcp-actions"><button type="button" className="btn-ghost sm" onClick={() => { setDraft(toDraft(name, e)); setError(null); }}>Edit</button><button type="button" className="btn-ghost sm danger" onClick={() => setRm(name)}>Remove</button></div>}
            </li>
          ))}
        </ul>
      )}
      {draft ? (
        <div className="set-card mcp-form">
          <h4>{draft.orig ? `Edit ${draft.orig}` : 'Add a server'}</h4>
          <Field id="mcp-name" label="Name"><input id="mcp-name" data-autofocus autoFocus value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="github" spellCheck={false} /></Field>
          <div className="set-field"><span className="set-label">Type</span>
            <div className="seg" role="radiogroup" aria-label="Server type">
              {(['stdio', 'http', 'sse'] as const).map((t) => <button key={t} type="button" role="radio" aria-checked={draft.type === t} className={draft.type === t ? 'on' : ''} onClick={() => set({ type: t })}>{t}</button>)}
            </div>
            <span className="set-hint">{draft.type === 'stdio' ? 'Legion starts a program on this computer.' : 'Legion connects to a server at a URL.'}</span>
          </div>
          {draft.type === 'stdio' ? (<>
            <Field id="mcp-cmd" label="Command"><input id="mcp-cmd" value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" spellCheck={false} /></Field>
            <Field id="mcp-args" label="Arguments" hint="One per line."><textarea id="mcp-args" rows={3} value={draft.args} onChange={(e) => set({ args: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-github'} spellCheck={false} /></Field>
            <KvEditor label="Environment" hint="Optional. Hidden values stay as they are unless you type a new one." rows={draft.env} onChange={(env) => set({ env })} keyPh="GITHUB_TOKEN" />
          </>) : (<>
            <Field id="mcp-url" label="URL"><input id="mcp-url" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} /></Field>
            <KvEditor label="Headers" hint="Optional. Hidden values stay as they are unless you type a new one." rows={draft.headers} onChange={(headers) => set({ headers })} keyPh="Authorization" />
          </>)}
          <SaveBar dirty busy={busy} error={error} onSave={() => void save()} onReset={() => { setDraft(null); setError(null); }} label={draft.orig ? 'Save server' : 'Add server'} />
        </div>
      ) : (
        <div className="set-savebar">
          {error && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>}
          <div className="set-actions"><button type="button" className="btn" onClick={() => { setDraft(toDraft(null)); setError(null); }}><Icon name="plus" size={13} /> Add server</button></div>
        </div>
      )}
      <McpStatus s={s} />
    </div>
  );
}

/* ---------------- Connections ---------------- */
function Snippet({ title, lead, shown, real }: { title: string; lead: string; shown: string; real: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="set-card snip">
      <h4>{title}</h4><p className="set-hint">{lead}</p>
      <div className="set-code"><pre>{shown}</pre>
        <button type="button" className="btn-ghost sm" onClick={async () => { if (await copyText(real)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}><Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
/* ---------------- Blender ---------------- */
function BlenderSection() {
  const st = useBlender((x) => x.status);
  const busy = useBlender((x) => x.busy);
  const steps = useBlender((x) => x.steps);
  const stepsTitle = useBlender((x) => x.stepsTitle);
  const error = useBlender((x) => x.error);
  const retrust = useBlender((x) => x.retrust);
  const getApprovals = useStore((x) => x.approvals).filter((a) => a.toolName === GET_BLENDER_TOOL);
  const [port, setPort] = useState('');
  const [path, setPath] = useState('');
  useEffect(() => { void loadBlender(true); }, []);
  useEffect(() => { if (st) { setPort(String(st.port)); setPath(''); } }, [st?.port]);
  if (!st) return <div className="set-section"><Head title="Blender" lead="Loading" />{error ? <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div> : <div className="set-loading"><span className="spin" /> Reading Blender status{'\u2026'}</div>}</div>;
  const { label, tone } = lightLabel(st.light);
  const dot = tone === 'on' ? 'ok' : tone === 'bad' ? 'bad' : 'none';
  const off = !st.enabled;
  const b = busy !== null;
  const portNum = Number(port);
  const portDirty = port !== String(st.port);
  const portOk = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535;
  const pathDirty = path.trim() !== '';
  const curMode = st.mode ?? (st.sandbox === 'off' ? 'live' : st.sandbox === 'vm' ? 'vm' : 'auto');
  const liveOk = curMode === 'live' || curMode === 'auto';
  const notices = visibleNotices(st);
  const mg = st.managed;
  return (
    <div className="set-section">
      <Head title="Blender" lead="The Sculptor can build 3D scenes in Blender. Every script is checked, shown to you in full and needs your OK. By default it runs in Blender on this computer when Blender is found." />
      <div className="set-card">
        <div className={`set-status st-${dot}`} role="status"><i className="set-dot" /><b>{label}</b><span className="muted-s">{st.summary}</span></div>
        <label className="set-check"><input type="checkbox" checked={st.enabled} disabled={b} onChange={(e) => { if (e.target.checked) requestEnableBlender(); else void saveBlenderConfig({ enabled: false }); }} />
          <span><b>Turn on the Blender bridge</b><em>Off by default. Nothing is detected, downloaded or given to agents until you turn it on.</em></span></label>
        <div className="set-field"><span className="set-label">Backend</span>
          <div className="seg" role="radiogroup" aria-label="Blender backend">
            {(['auto', 'official', 'community'] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={st.backendChoice === k} disabled={b || off} className={st.backendChoice === k ? 'on' : ''} onClick={() => void saveBlenderConfig({ backend: k })}>{k === 'auto' ? 'Auto' : k === 'official' ? 'Official (5.1+)' : 'Community'}</button>
            ))}
          </div>
          <span className="set-hint">{off ? 'Auto uses the official Blender Lab MCP for Blender 5.1+, and the community MCP for older versions.' : st.backendReason}</span>
        </div>
        <div className="set-field"><span className="set-label">Where scripts run</span>
          <div className="bl-modes" role="radiogroup" aria-label="Where scripts run">
            {MODE_CHOICES.map((c) => (
              <button key={c.mode} type="button" role="radio" aria-checked={curMode === c.mode} disabled={b || off} className={`bl-mode${curMode === c.mode ? ' on' : ''}`} onClick={() => void saveBlenderConfig({ mode: c.mode })}>
                <b>{c.title}</b><span>{c.text}</span>
              </button>
            ))}
          </div>
          <span className="set-hint" aria-live="polite">{st.nextRun ? `Next script runs: ${st.nextRun.replace(/^[Nn]ext script runs?:?\s*/, '')}` : st.sandboxReady ? 'Cloud VM is ready.' : st.sandboxNote}</span>
        </div>
        <div className="set-field">
          <label className="set-check"><input type="checkbox" checked={st.both?.enabled === true} disabled={b || off} onChange={(e) => void saveBlenderConfig({ both: e.target.checked })} />
            <span><b>{BOTH_TITLE}</b><em>{BOTH_TEXT}</em></span></label>
          {st.both && st.both.enabled && <span className="set-hint" aria-live="polite">{st.both.note}{st.both.extras.length ? ` Extra tools: ${st.both.extras.join(', ')}.` : ''}</span>}
          {st.both && st.both.enabled && (
            <div className="bl-assets" role="group" aria-label={ASSETS_TITLE}>
              <b>{ASSETS_TITLE}</b><span className="set-hint">{ASSETS_TEXT}</span>
              {st.both.assets.map((a) => (
                <label key={a.source} className="set-check"><input type="checkbox" checked={a.enabled} disabled={b || off || !a.supported} onChange={(e) => void saveBlenderConfig({ assets: { polyhaven: e.target.checked } })} />
                  <span><b>{a.source === 'polyhaven' ? 'Poly Haven (HDRIs and models, free)' : a.source}</b>{!a.supported && <em>Not available: {a.reason}.</em>}</span></label>
              ))}
            </div>
          )}
        </div>
        <div className="set-field bl-get"><span className="set-label">Blender for Legion</span>
          {mg?.installed
            ? <span className="set-hint">Installed for Legion: Blender {mg.installed.version} at {mg.installed.path}. Delete that folder to remove it.</span>
            : <span className="set-hint">{GET_BLENDER_TEXT} {!mg?.supported ? 'Only available on Windows in this version.' : !mg.pinned ? GET_BLENDER_NOT_PINNED : `Blender ${mg.version} (${mg.channel}), about ${mg.approxMb} MB.`}</span>}
          {getApprovals.map((a) => (
            <div key={a.id} className="bl-get-card" role="group" aria-label="Approval needed for the Blender download">
              <b>Needs your OK</b><pre>{a.summary}</pre>
              <div className="set-actions"><button type="button" className="btn primary" onClick={() => void decide(a.id, true)}>Allow</button><button type="button" className="btn" onClick={() => void decide(a.id, false)}>Deny</button></div>
            </div>
          ))}
          <div className="set-actions">
            <button type="button" className="btn" disabled={b || off || !mg || !mg.supported || !mg.pinned || !!mg.installed || !!mg.getting} onClick={() => void runBlenderGet()}>{busy === 'get' || mg?.getting ? 'Waiting\u2026' : 'Get Blender for Legion'}</button>
            <a className="btn-ghost" href={mg?.downloadPage ?? 'https://www.blender.org/download/'} target="_blank" rel="noopener noreferrer">Get full Blender</a>
          </div>
          <span className="set-hint">{FULL_BLENDER_TEXT}</span>
        </div>
        <div className="bl-note warn">{NOT_TRIED_VM} Use Test after Set up and check docs/BLENDER.md for the list of checks.</div>
        <div className="bl-note warn">{NOT_TRIED_LOCAL} Docs and PC checks: docs/BLENDER.md, claude/tracker-pc-checks.md.</div>
        <div className="set-actions">
          <button type="button" className="btn primary" disabled={b || off} onClick={() => void runBlenderSetup('both')}>{busy === 'setup' ? 'Setting up\u2026' : 'Set up'}</button>
          <button type="button" className="btn" disabled={b || off} onClick={() => void runBlenderTest()}>{busy === 'test' ? 'Testing\u2026' : 'Test connection'}</button>
          <button type="button" className="btn" disabled={b || off || st.installs.length === 0} onClick={() => void runBlenderLaunch()}>Launch Blender</button>
          <button type="button" className="btn-ghost" disabled={b || off} onClick={() => void loadBlender(true)}>Detect again</button>
        </div>
        <span className="set-hint">Set up downloads the backend from its official source, installs the add-on into Blender and saves how to start it. It only runs when you press it.</span>
        {error && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>}
        {retrust && (
          <div className="bl-note warn" role="alert"><b>The {retrust} download changed.</b> It is not the file you trusted before, so nothing was installed or replaced. If you expected an update, accept it; if not, leave it and check the source.
            <div className="set-actions"><button type="button" className="btn" disabled={b} onClick={() => void runBlenderSetup('both', true)}>Trust the new download</button></div></div>
        )}
        {notices.length > 0 && <ul className="bl-notices" aria-label="Limits and warnings">{notices.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        {steps.length > 0 && (
          <div className="set-field"><span className="set-label">{stepsTitle}</span>
            <ul className="bl-steps">{steps.map((x, i) => <li key={i} className={x.ok ? 'ok' : 'bad'}><Icon name={x.ok ? 'check' : 'x'} size={13} /><span><b>{x.step}</b>{x.detail}</span></li>)}</ul>
          </div>
        )}
      </div>
      {!off && (
        <div className="set-card">
          <div className="set-field"><span className="set-label">Blender on this computer</span>
            {st.installs.length === 0 ? <span className="set-hint">Not found. Install Blender from blender.org, or set its folder under Advanced.</span> : (
              <ul className="bl-install">{st.installs.map((i) => <li key={i.path} className={st.selected?.path === i.path ? 'sel' : ''}>{st.selected?.path === i.path ? '\u25cf ' : '\u25cb '}Blender {i.version}{i.versionGuessed ? ' (from folder name)' : ''} {'\u00b7'} {i.path}</li>)}</ul>
            )}
          </div>
          <details className="set-adv">
            <summary>Advanced</summary>
            <Field id="bl-port" label="My open Blender: add-on port" hint={`The port Blender's add-on listens on (this computer only). Default 9876.${liveOk ? '' : ' Not used while scripts are set to run on this computer or in the cloud VM.'}`}>
              <div className="set-inline">
                <input id="bl-port" className="narrow" inputMode="numeric" disabled={!liveOk} value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))} />
                <button type="button" className="btn" disabled={b || !liveOk || !portDirty || !portOk} onClick={() => void saveBlenderConfig({ port: portNum })}>Save port</button>
              </div>
            </Field>
            <Field id="bl-path" label="Blender location" hint="Only if detection misses your install: the blender executable or its folder. Leave empty to keep the current choice.">
              <div className="set-inline">
                <input id="bl-path" value={path} placeholder="C:\Program Files\Blender Foundation\Blender 5.1" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
                <button type="button" className="btn" disabled={b || !pathDirty} onClick={() => void saveBlenderConfig({ installPath: path.trim() })}>Use this</button>
              </div>
            </Field>
            <span className="set-hint">Download addresses, tool names and the VM run command are in config.json under blender.advanced.</span>
          </details>
        </div>
      )}
      <div className="bl-note"><b>Safety.</b> {LOCAL_SAFETY_NOTE}</div>
      <div className="bl-note"><b>Licence.</b> {BLENDER_LICENSE_NOTE}</div>
    </div>
  );
}

function ConnectionsSection({ s }: { s: SettingsView }) {
  const mask = '\u2022'.repeat(12);
  const cmd = (t: string) => `claude mcp add --transport http legion ${base}/mcp --header "Authorization: Bearer ${t}"`;
  // Claude Desktop only speaks stdio, so it goes through the small bridge script that ships with Legion
  const dir = (s.install?.dir ?? '%LOCALAPPDATA%/Programs/Legion').replace(/\\/g, '/').replace(/\/$/, '');
  // A prebuilt package has no system Node: the bridge runs on Legion's own Electron in node mode (the env entry switches that on).
  const json = JSON.stringify({ mcpServers: { legion: s.install?.packaged
    ? { command: `${dir}/runtime/electron/electron.exe`, args: [`${dir}/dist/src/bin/legion-mcp-stdio.js`], env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: 'node', args: [`${dir}/dist/src/bin/legion-mcp-stdio.js`] } } }, null, 2);
  return (
    <div className="set-section">
      <Head title="Connections" lead="Drive your agents from Claude Code, Claude Desktop or Cowork." />
      <Snippet title="Claude Code" lead="Run once in a terminal. Copy includes your access token; it stays hidden here. It lets Claude Code run and read agents, but not approve cards or change settings." shown={cmd(token ? mask : '<token>')} real={cmd(token || '<token>')} />
      <Snippet title="Claude Desktop and Cowork" lead="Add this to the mcpServers section of claude_desktop_config.json, then restart the app. It starts a small local bridge; no token needed." shown={json} real={json} />
    </div>
  );
}

/* ---------------- About ---------------- */
function AboutSection({ s }: { s: SettingsView }) {
  const version = useStore((x) => x.version);
  const rows: [string, string, boolean][] = [['Version', version ? `v${version}` : '\u2026', false], ['Data folder', s.dataDir, true], ['Config file', s.configPath, true], ['Local port', String(s.port), false]];
  return (
    <div className="set-section">
      <Head title="About" lead="Legion runs on this computer. Nothing here leaves it except your own Claude and boat.dev calls." />
      <dl className="set-about">
        {rows.map(([k, v, copy]) => (
          <div key={k}><dt>{k}</dt><dd><code>{v}</code>{copy && <button type="button" className="btn-ghost sm" onClick={() => void copyText(v).then((ok) => ok && toast('Copied'))}><Icon name="copy" size={12} /> Copy</button>}</dd></div>
        ))}
      </dl>
      <UpdatePanel />
      <BrowserSection />
    </div>
  );
}
