import { useEffect, useState } from 'react';
import type { ProviderView } from '../../../src/shared/providers-view';
import { useStore } from '../store';
import { allowStdio, getProviders, loadProviders, refreshModels, removeKey, removeProvider, saveEntry, saveKey, saveLead, saveLimits, stopStdio, testProvider, useProviders } from './providersStore';
import './providers.css';

const PLAIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

function ProviderCard({ p }: { p: ProviderView }) {
  const busy = useProviders((s) => s.busy);
  const note = useProviders((s) => s.notes[p.id]);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [addr, setAddr] = useState(p.baseUrl);
  const [editAddr, setEditAddr] = useState(false);
  const exp = useProviders((s) => s.view?.experimental === true);
  const mine = busy === p.id;
  const submitKey = async () => { const k = key; setKey(''); if (k.trim()) await saveKey(p.id, k.trim()); };
  return (
    <article className="prov-card" aria-label={p.label}>
      <header>
        <div><b>{p.label}</b> <code className="prov-id">{p.id}</code></div>
        <label className="prov-switch"><input type="checkbox" checked={p.enabled} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { enabled: e.target.checked })} /> {p.enabled ? 'On' : 'Off'}</label>
      </header>
      {p.note && <p className="field-note">{p.note}</p>}
      <p className="prov-status" role="status">{p.status}</p>
      {p.lastTest && <p className="field-note">{p.lastTest.detail}</p>}
      <div className="prov-row">
        <span className="field-note">Address</span>
        {editAddr
          ? <><input value={addr} onChange={(e) => setAddr(e.target.value)} aria-label={`${p.label} address`} spellCheck={false} />
            <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void saveEntry(p.id, { baseUrl: addr.trim() }).then((ok) => ok && setEditAddr(false))}>Change (confirm in dialog)</button>
            <button type="button" className="btn-ghost sm" onClick={() => { setAddr(p.baseUrl); setEditAddr(false); }}>Cancel</button></>
          : <><code>{p.baseUrl}</code><button type="button" className="btn-ghost sm" onClick={() => setEditAddr(true)}>Change</button></>}
      </div>
      <div className="prov-row">
        <label>API format
          <select value={p.wire} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { wire: e.target.value })}>
            <option value="chat">Chat completions (works with most servers)</option>
            <option value="responses">Responses API (OpenAI)</option>
          </select>
        </label>
      </div>
      {(p.needsKey || p.keySet) && (
        <form className="prov-row" onSubmit={(e) => { e.preventDefault(); void submitKey(); }}>
          <label className="grow">API key
            <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.keySet ? `Saved (${p.keyHint ?? '…'}). Paste a new one to replace it.` : 'Paste your key'} />
          </label>
          <button type="submit" className="btn sm" disabled={!!busy || !key.trim()}>Save key</button>
          {p.keySet && <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void removeKey(p.id)}>Remove key</button>}
        </form>
      )}
      {exp && <>
      <p className="prov-status" data-testid={`taint-${p.id}`}>
        {p.startsTainted
          ? 'Runs on this provider start marked as touching outside content (tainted): it is a custom endpoint Legion knows nothing about.'
          : p.trusted ? 'Runs on this provider do not start marked as outside content: you marked this endpoint trusted.' : 'Runs on this provider do not start marked as outside content (this computer, or the provider\'s own address).'}
      </p>
      {!p.preset && !p.loopback && (
        <label className="check-row"><input type="checkbox" checked={p.trusted} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { trusted: e.target.checked })} /> I trust this endpoint (asks you to confirm in a dialog)</label>
      )}
      <div className="prov-row">
        <label>Token limit per task<input type="number" min={1} defaultValue={p.tokenCapPerTask ?? ''} placeholder="No limit" onBlur={(e) => { const v = e.target.value.trim(); void saveEntry(p.id, { tokenCapPerTask: v ? Number(v) : null }); }} /></label>
        <label>Token limit per day<input type="number" min={1} defaultValue={p.tokenCapPerDay ?? ''} placeholder="No limit" onBlur={(e) => { const v = e.target.value.trim(); void saveEntry(p.id, { tokenCapPerDay: v ? Number(v) : null }); }} /></label>
        <span className="field-note">{(p.tokensToday ?? 0).toLocaleString()} tokens counted today. Counts come from what the provider returns, or an estimate (characters divided by 4) when it returns none. A model turn already running can pass the limit; the next one is not started.</span>
      </div>
      <label className="check-row"><input type="checkbox" checked={p.leadSelectable} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { leadSelectable: e.target.checked })} /> Lead agents may run any agent on any model of this provider (off by default; asks you to confirm)</label>
      </>}
      <div className="prov-row">
        <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void testProvider(p.id)}>{mine ? 'Working…' : 'Test'}</button>
        <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void refreshModels(p.id)}>Refresh models</button>
        <span className="field-note">Test and Refresh make one request to the address above, only when you press them.</span>
      </div>
      <div className="prov-row">
        <span className="field-note">{p.models.length ? `${p.models.length} model id${p.models.length === 1 ? '' : 's'} listed` : 'No model ids listed yet'}</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Add a model id" aria-label={`Add a model id for ${p.label}`} spellCheck={false} />
        <button type="button" className="btn-ghost sm" disabled={!!busy || !model.trim() || /\s/.test(model)} onClick={() => { const m = model.trim(); setModel(''); void saveEntry(p.id, { models: [...new Set([...p.models, m])] }); }}>Add</button>
      </div>
      {!p.preset && <button type="button" className="btn-ghost sm danger" disabled={!!busy} onClick={() => void removeProvider(p.id)}>Remove this provider</button>}
      {note && <p className="field-note" role="status">{note}</p>}
    </article>
  );
}

function CliCard({ p }: { p: ProviderView }) {
  const busy = useProviders((s) => s.busy);
  const agents = useStore((s) => s.agents);
  const view = useProviders((s) => s.view);
  const [exe, setExe] = useState(p.executable ?? '');
  const allowed = new Set(p.allowedAgents ?? []);
  const toggle = (id: string, on: boolean) => { const next = new Set(allowed); if (on) next.add(id); else next.delete(id); void saveEntry(p.id, { allowedAgents: [...next] }); };
  return (
    <article className="prov-card prov-cli" aria-label={p.label}>
      <header><div><b>{p.label}</b> <code className="prov-id">{p.id}</code> <span className="field-note">{p.cli === 'codex' ? 'Codex CLI' : 'OpenCode CLI'} on this computer</span></div>
        <label className="prov-switch"><input type="checkbox" checked={p.enabled} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { enabled: e.target.checked })} /> {p.enabled ? 'On' : 'Off'}</label></header>
      <p className="set-error" role="note">{view?.cliWarning}</p>
      <p className="prov-status" role="status">{p.status}. Every run of it starts marked as touching outside content, and only you, in the app, can start it. You approve each start on a card showing the command, the folder and the sandbox flag.</p>
      <div className="prov-row">
        <label className="grow">Program (full path)<input value={exe} onChange={(e) => setExe(e.target.value)} spellCheck={false} /></label>
        <button type="button" className="btn-ghost sm" disabled={!!busy || exe === p.executable} onClick={() => void saveEntry(p.id, { executable: exe.trim() })}>Change (confirm in dialog)</button>
        <label>Sandbox flag
          <select value={p.sandbox} disabled={!!busy} onChange={(e) => void saveEntry(p.id, { sandbox: e.target.value })}>
            <option value="read-only">read-only (strictest)</option><option value="workspace-write">workspace-write</option>
          </select>
        </label>
      </div>
      <fieldset className="prov-add"><legend>Agents it is enabled for</legend>
        {agents.length === 0 && <span className="field-note">No agents yet.</span>}
        {agents.map((a) => <label key={a.id} className="check-row"><input type="checkbox" checked={allowed.has(a.id)} disabled={!!busy} onChange={(e) => toggle(a.id, e.target.checked)} /> {a.name} <code className="prov-id">{a.id}</code></label>)}
        <span className="field-note">Then set that agent's model to <code>{p.id}:default</code>. Its login is the program's own: sign in to it outside Legion. A continued task starts the program fresh each time.</span>
      </fieldset>
      <button type="button" className="btn-ghost sm danger" disabled={!!busy} onClick={() => void removeProvider(p.id)}>Remove this CLI</button>
    </article>
  );
}

function AddCli() {
  const busy = useProviders((s) => s.busy);
  const [id, setId] = useState(''); const [cli, setCli] = useState<'codex' | 'opencode'>('codex'); const [exe, setExe] = useState('');
  const ok = PLAIN_ID.test(id) && exe.trim().length > 0;
  return (
    <fieldset className="prov-add">
      <legend>Add Codex or OpenCode on this computer (off by default)</legend>
      <p className="field-note">The recommended way is inside an agent's VM (the vm_cli tool), where the VM is the boundary. This option runs the program here instead. It is added turned off; you turn it on and pick the agents in a second, confirmed step. Legion never installs it and never touches its login.</p>
      <div className="prov-row">
        <label>Short name<input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="codexcli" spellCheck={false} /></label>
        <label>Program<select value={cli} onChange={(e) => setCli(e.target.value as 'codex' | 'opencode')}><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
        <label className="grow">Full path of the program<input value={exe} onChange={(e) => setExe(e.target.value)} placeholder="C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd" spellCheck={false} /></label>
        <button type="button" className="btn sm" disabled={!ok || !!busy} onClick={() => void saveEntry(id, { kind: 'cli', cli, label: cli === 'codex' ? 'Codex CLI' : 'OpenCode CLI', executable: exe.trim(), enabled: false }).then((d) => { if (d) { setId(''); setExe(''); } })}>Add (confirm in dialog)</button>
      </div>
    </fieldset>
  );
}

function StdioServers() {
  const view = useProviders((s) => s.view);
  const busy = useProviders((s) => s.busy);
  const notes = useProviders((s) => s.notes);
  const list = view?.stdioServers ?? [];
  return (
    <fieldset className="prov-add">
      <legend>Local MCP servers in provider runs</legend>
      <p className="field-note">A local MCP server from Settings starts a program on this computer. It does not start in a run on another provider unless you allow it here. The permission covers exactly the command line shown; if you change the command in Settings it is switched off again. The program gets a small environment, and it and everything it started are stopped when the run ends or is cancelled. Servers that connect over https are not affected.</p>
      {list.length === 0 && <span className="field-note">No local MCP servers in Settings.</span>}
      {list.map((m) => (
        <div key={m.name} className="prov-row">
          <b>{m.name}</b> <code>{m.commandLine}</code>
          {m.allowed
            ? <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void stopStdio(m.name)}>Allowed: stop allowing</button>
            : <button type="button" className="btn sm" disabled={!!busy} onClick={() => void allowStdio(m.name)}>Allow for provider runs (confirm in dialog)</button>}
          {m.changedSinceAllowed && <span className="field-note">The command changed since you allowed it, so it is off.</span>}
          {notes[`mcp:${m.name}`] && <span className="field-note">{notes[`mcp:${m.name}`]}</span>}
        </div>
      ))}
    </fieldset>
  );
}

function LeadChoices() {
  const view = useProviders((s) => s.view);
  const busy = useProviders((s) => s.busy);
  const agents = useStore((s) => s.agents);
  const [agent, setAgent] = useState(''); const [val, setVal] = useState('');
  const choices = view?.leadChoices ?? {};
  const ok = agent && /^[a-z][a-z0-9-]{1,31}:\S+$/.test(val.trim());
  return (
    <fieldset className="prov-add">
      <legend>Lead choices: which models a lead may pick for an agent</legend>
      <p className="field-note">By default a lead agent can never move another agent to a different provider, because that decides where your data goes. List the <code>provider:model</code> values a lead may choose when it delegates to an agent. Only those, for that one task. The run still uses the lead's approval limits and "outside content" marking, and a lead that has read outside content cannot choose a provider you have not marked trusted.</p>
      {Object.entries(choices).map(([aid, list]) => (
        <div key={aid} className="prov-row">
          <b>{agents.find((a) => a.id === aid)?.name ?? aid}</b>
          {list.map((c) => <span key={c} className="prov-chip"><code>{c}</code> <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void saveLead(aid, list.filter((x) => x !== c))}>Remove</button></span>)}
        </div>
      ))}
      <div className="prov-row">
        <label>Agent<select value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">Choose…</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="grow">Provider and model<input value={val} onChange={(e) => setVal(e.target.value)} placeholder="openrouter:anthropic/claude-sonnet-4.5" spellCheck={false} /></label>
        <button type="button" className="btn sm" disabled={!ok || !!busy} onClick={() => void saveLead(agent, [...new Set([...(choices[agent] ?? []), val.trim()])]).then((d) => { if (d) setVal(''); })}>Allow (confirm in dialog)</button>
      </div>
    </fieldset>
  );
}

function AddCustom() {
  const busy = useProviders((s) => s.busy);
  const [id, setId] = useState(''); const [label, setLabel] = useState(''); const [url, setUrl] = useState('');
  const ok = PLAIN_ID.test(id) && url.trim().length > 0;
  return (
    <fieldset className="prov-add">
      <legend>Add a custom endpoint</legend>
      <p className="field-note">Any server that speaks the OpenAI chat-completions format: your own gateway, vLLM, LM Studio or another host. https is required unless the server is on this computer.</p>
      <div className="prov-row">
        <label>Short name<input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="mygateway" spellCheck={false} /></label>
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My gateway" /></label>
        <label className="grow">Address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://llm.example.com/v1" spellCheck={false} /></label>
        <button type="button" className="btn sm" disabled={!ok || !!busy} onClick={() => void saveEntry(id, { label: label.trim() || id, baseUrl: url.trim(), enabled: true }).then((done) => { if (done) { setId(''); setLabel(''); setUrl(''); } })}>Add (confirm in dialog)</button>
      </div>
    </fieldset>
  );
}

export function ProvidersSection() {
  const view = useProviders((s) => s.view);
  const error = useProviders((s) => s.error);
  const [turns, setTurns] = useState(''); const [calls, setCalls] = useState('');
  useEffect(() => { void loadProviders(); }, []);
  useEffect(() => { if (view) { setTurns(String(view.maxTurns)); setCalls(String(view.maxToolCallsPerTurn)); } }, [view?.maxTurns, view?.maxToolCallsPerTurn]);
  return (
    <div className="set-section">
      <header className="set-head">
        <h3>Providers</h3>
        <p>Run an agent on a model from another provider. Claude stays the default and nothing changes until you pick a provider model for an agent. Legion's own code makes a request to a provider only to the address you set here.</p>
      </header>
      {error && <div className="set-error" role="alert">{error}</div>}
      {!view ? <div className="set-loading"><span className="spin" /> Loading{'…'}</div> : <>
        <details className="prov-limits" open>
          <summary>What an agent on a provider cannot do</summary>
          <ul>{view.cannotDo.map((t) => <li key={t}>{t}</li>)}</ul>
          <p className="field-note">Provider support has been built and tested against Legion's own fake servers. It has not been tried against the real services yet; a failed request shows the provider's own message.</p>
        </details>
        {view.dropped.length > 0 && <div className="set-error" role="status">Some saved providers were ignored: {view.dropped.join('; ')}</div>}
        {view.providers.map((p) => (p.kind === 'cli' ? <CliCard key={p.id} p={p} /> : <ProviderCard key={p.id} p={p} />))}
        <AddCustom />
        {view.experimental && <><AddCli /><StdioServers /><LeadChoices /></>}
        <fieldset className="prov-add">
          <legend>Run limits for provider agents</legend>
          <div className="prov-row">
            <label>Most model turns per run<input type="number" min={1} max={200} value={turns} onChange={(e) => setTurns(e.target.value)} /></label>
            <label>Most tool calls per turn<input type="number" min={1} max={64} value={calls} onChange={(e) => setCalls(e.target.value)} /></label>
            <button type="button" className="btn sm" disabled={!!getProviders().busy} onClick={() => void saveLimits(Number(turns), Number(calls))}>Save</button>
          </div>
          <p className="field-note">Cost is shown only when a provider returns token counts and you have entered prices. {view.roomBudgetNote}</p>
        </fieldset>
        <p className="field-note">Going back to an older Legion version: the older version ignores this page. An agent still set to a provider model will fail with a model error there; it never sends anything to a provider.</p>
      </>}
    </div>
  );
}
