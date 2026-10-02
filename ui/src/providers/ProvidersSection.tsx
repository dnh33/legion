import { useEffect, useState } from 'react';
import type { ProviderView } from '../../../src/shared/providers-view';
import { getProviders, loadProviders, refreshModels, removeKey, removeProvider, saveEntry, saveKey, saveLimits, testProvider, useProviders } from './providersStore';
import './providers.css';

const PLAIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

function ProviderCard({ p }: { p: ProviderView }) {
  const busy = useProviders((s) => s.busy);
  const note = useProviders((s) => s.notes[p.id]);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [addr, setAddr] = useState(p.baseUrl);
  const [editAddr, setEditAddr] = useState(false);
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
        {view.providers.map((p) => <ProviderCard key={p.id} p={p} />)}
        <AddCustom />
        <fieldset className="prov-add">
          <legend>Run limits for provider agents</legend>
          <div className="prov-row">
            <label>Most model turns per run<input type="number" min={1} max={200} value={turns} onChange={(e) => setTurns(e.target.value)} /></label>
            <label>Most tool calls per turn<input type="number" min={1} max={64} value={calls} onChange={(e) => setCalls(e.target.value)} /></label>
            <button type="button" className="btn sm" disabled={!!getProviders().busy} onClick={() => void saveLimits(Number(turns), Number(calls))}>Save</button>
          </div>
          <p className="field-note">Cost is shown only when a provider returns token counts and you have entered prices. Room spend limits count known costs only, so an agent on a provider with unknown cost adds nothing to a room's meter.</p>
        </fieldset>
        <p className="field-note">Going back to an older Legion version: the older version ignores this page. An agent still set to a provider model will fail with a model error there; it never sends anything to a provider.</p>
      </>}
    </div>
  );
}
