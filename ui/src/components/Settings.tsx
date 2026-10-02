import { useEffect, useState, type ReactNode } from 'react';
import type { McpServerEntry, SettingsPatch, SettingsView } from '../../../src/shared/types';
import { api, base, openExternal, token } from '../api';
import { checkBoat, closeSettings, errText, loadSettings, saveSettings, setSettingsSection as setSection, toast, useStore, type SettingsSection } from '../store';
import { copyText } from '../util';
import { Icon } from './icons';

const NAV: { id: SettingsSection; label: string; hint: string }[] = [
  { id: 'claude', label: 'Claude', hint: 'Sign-in, key, runs' },
  { id: 'boat', label: 'boat.dev (VMs)', hint: 'Cloud computers' },
  { id: 'mcp', label: 'MCP servers', hint: 'Extra tools for agents' },
  { id: 'connections', label: 'Connections', hint: 'Use Legion from Claude' },
  { id: 'about', label: 'About', hint: 'Version and folders' },
];

export function SettingsPanel() {
  const section = useStore((s) => s.settingsSection);
  const settings = useStore((s) => s.settings);
  useEffect(() => { if (!settings) void loadSettings(); }, []);
  return (
    <section className="settings" aria-label="Settings">
      <nav className="set-nav" aria-label="Settings sections">
        <button className="set-back" onClick={closeSettings} aria-label="Back to chat" title="Back to chat (Esc)"><Icon name="chevron" size={13} /> <span>Back to chat</span></button>
        <h2>Settings</h2>
        {NAV.map((n) => (
          <button key={n.id} className={`set-link${section === n.id ? ' sel' : ''}`} aria-current={section === n.id} onClick={() => setSection(n.id)}>
            <b>{n.label}</b><span>{n.hint}</span>
          </button>
        ))}
      </nav>
      <div className="set-scroll scroll-cue">
        <div className="set-body">
          {!settings ? <div className="set-loading"><span className="spin" /> Loading settings{'…'}</div> : (
            section === 'claude' ? <ClaudeSection s={settings} />
              : section === 'boat' ? <BoatSection s={settings} />
                : section === 'mcp' ? <McpSection s={settings} />
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
  const [turns, setTurns] = useState(String(c.maxTurns));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRm, setConfirmRm] = useState(false);
  const reset = () => { setAuth(c.auth); setKey(''); setExec(c.executablePath ?? ''); setInherit(c.inheritClaudeCodeSettings); setTurns(String(c.maxTurns)); setError(null); };
  useEffect(reset, [JSON.stringify(c)]);
  const dirty = auth !== c.auth || key !== '' || exec !== (c.executablePath ?? '') || inherit !== c.inheritClaudeCodeSettings || turns !== String(c.maxTurns);

  const save = async () => {
    const n = Number(turns);
    if (!Number.isInteger(n) || n < 1 || n > 1000) { setError('Max turns must be a whole number between 1 and 1000.'); return; }
    if (auth === 'api-key' && !key && !c.apiKeySet) { setError('Paste an Anthropic API key to use API key mode.'); return; }
    setBusy(true); setError(null);
    const patch: SettingsPatch = { claude: { auth, inheritClaudeCodeSettings: inherit, maxTurns: n, executablePath: exec.trim() || null, ...(key ? { apiKey: key.trim() } : {}) } };
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
          <span><b>Inherit my Claude Code settings</b><em>Agents also read your user and project settings, hooks and CLAUDE.md, like Claude Code in a terminal.</em></span></label>
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
            {health?.forbidden.map((f) => (
              <p key={f.action} className="set-perm bad"><Icon name="x" size={13} /> <span>This key cannot <code>{f.action}</code>. Create a full-access key in boat.dev and paste it above.</span></p>
            ))}
            {health?.checkedAt && health.forbidden.length === 0 && (
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
function ConnectionsSection({ s }: { s: SettingsView }) {
  const mask = '\u2022'.repeat(12);
  const cmd = (t: string) => `claude mcp add --transport http legion ${base}/mcp --header "Authorization: Bearer ${t}"`;
  // Claude Desktop only speaks stdio, so it goes through the small bridge script that ships with Legion
  const dir = ((s as SettingsView & { installDir?: string }).installDir ?? '%LOCALAPPDATA%/Programs/Legion').replace(/\\/g, '/').replace(/\/$/, '');
  const json = JSON.stringify({ mcpServers: { legion: { command: 'node', args: [`${dir}/dist/src/bin/legion-mcp-stdio.js`] } } }, null, 2);
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
    </div>
  );
}
