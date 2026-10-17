import { useEffect, useState } from 'react';
import type { WebProviderId } from '../../../src/shared/web-search-config';
import { acceptNotice, chooseProvider, clearAddress, dismissNotice, loadWebSearch, removeKey, runTest, saveAddress, saveCap, saveKey, useWebSearch } from './webSearchStore';
import { APPLIES_LINE, keyPlaceholder, noticeParagraphs, parseCap, pickedNotReady, selectOptions } from './webSearchModel';
import type { WebJob } from './webSearchModel';
import './providers.css';

const KEY_PROVIDERS: ReadonlyArray<{ id: WebProviderId; label: string }> = [
  { id: 'treg', label: 'treg' }, { id: 'exa', label: 'Exa' }, { id: 'tavily', label: 'Tavily' }, { id: 'brave', label: 'Brave Search' },
];

function KeyRow({ id, label }: { id: WebProviderId; label: string }) {
  const v = useWebSearch((s) => s.view)!;
  const busy = useWebSearch((s) => s.busy);
  const note = useWebSearch((s) => s.notes[id]);
  const [key, setKey] = useState('');
  const isSet = !!v.keys[`web:${id}`]?.set;
  const submit = async () => { const k = key.trim(); setKey(''); if (k) await saveKey(id, k); };
  return (
    <>
      <form className="prov-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="grow">{label} key
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyPlaceholder(v, id)} />
        </label>
        <button type="submit" className="btn sm" disabled={!!busy || !key.trim()}>Save key</button>
        {isSet && <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void removeKey(id)}>Remove key</button>}
      </form>
      {note && <p className="field-note" role="status">{note}</p>}
    </>
  );
}

export function WebSearchSection() {
  const v = useWebSearch((s) => s.view);
  const busy = useWebSearch((s) => s.busy);
  const error = useWebSearch((s) => s.error);
  const pending = useWebSearch((s) => s.pending);
  const test = useWebSearch((s) => s.test);
  const note = useWebSearch((s) => s.notes.searxng ?? s.notes.search ?? s.notes.read);
  const [cap, setCap] = useState(''); const [capErr, setCapErr] = useState('');
  const [addr, setAddr] = useState('');
  useEffect(() => { void loadWebSearch(); }, []);
  useEffect(() => { if (v) { setCap(String(v.tregMaxCostUsd)); setAddr(v.searxng?.baseUrl ?? ''); } }, [v?.tregMaxCostUsd, v?.searxng?.baseUrl]);
  if (!v) return null;
  const jobs: Array<{ job: WebJob; label: string }> = [{ job: 'search', label: 'Search with' }, { job: 'read', label: 'Read pages with' }];
  const target: WebProviderId | undefined = v.search !== 'builtin' ? v.search : v.read !== 'builtin' ? v.read : undefined;
  const missing = [pickedNotReady(v, 'search'), pickedNotReady(v, 'read')].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  return (
    <fieldset className="prov-add" aria-label="Web search">
      <legend>Web search</legend>
      <p className="field-note">Agents search and read pages with Claude's built-in web tools. Pick a provider to use its search or page reader instead. Every page an agent reads still passes the same per-site check.</p>
      <div className="prov-row">
        {jobs.map(({ job, label }) => (
          <label key={job}>{label}
            <select value={v[job]} disabled={!!busy} onChange={(e) => void chooseProvider(job, e.target.value)}>
              {selectOptions(v, job).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ))}
      </div>
      <p className="field-note">{APPLIES_LINE}</p>
      {missing.map((name) => <p key={name} className="field-note" role="status">{name} is picked but not set up yet. Add its {name === 'SearXNG' ? 'address' : 'key'} below.</p>)}
      {pending && (
        <div className="prov-card" role="group" aria-label={`Before you use ${pending.name}`}>
          {noticeParagraphs(pending.notice).map((t) => <p key={t} className="prov-notice">{t}</p>)}
          <div className="prov-row">
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => void acceptNotice()}>{pending.enableLabel}</button>
            <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={dismissNotice}>Keep the built-in tools</button>
          </div>
        </div>
      )}
      {KEY_PROVIDERS.map((p) => <KeyRow key={p.id} id={p.id} label={p.label} />)}
      <div className="prov-row">
        <label>Your cap per call
          <input className="narrow" inputMode="decimal" spellCheck={false} value={cap} onChange={(e) => { setCap(e.target.value); setCapErr(''); }} aria-describedby="ws-cap-note" />
        </label>
        <button type="button" className="btn sm" disabled={!!busy || cap === String(v.tregMaxCostUsd)} onClick={() => { const r = parseCap(cap, v.capLimits); if (r.ok) void saveCap(r.value); else setCapErr(r.error); }}>Save cap</button>
        <span id="ws-cap-note" className="field-note">treg only. The most one treg call may cost, in US dollars.</span>
      </div>
      {capErr && <p className="set-error" role="alert">{capErr}</p>}
      <form className="prov-row" onSubmit={(e) => { e.preventDefault(); if (addr.trim()) void saveAddress(addr.trim()); }}>
        <label className="grow">SearXNG address
          <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="https://search.example.org" spellCheck={false} />
        </label>
        <button type="submit" className="btn sm" disabled={!!busy || !addr.trim() || addr.trim() === v.searxng?.baseUrl}>Save address</button>
        {v.searxng && <button type="button" className="btn-ghost sm" disabled={!!busy} onClick={() => void clearAddress()}>Remove address</button>}
      </form>
      <div className="prov-row">
        <button type="button" className="btn-ghost sm" disabled={!!busy || !target} onClick={() => void runTest(target)}>{busy === 'test' ? 'Working…' : 'Test'}</button>
        <span className="field-note">{target ? 'Test makes one small search at the provider you picked. With treg it is a paid call, within your cap.' : 'Pick a provider to test it.'}</span>
      </div>
      {test && <p className={test.ok ? 'field-note' : 'set-error'} role={test.ok ? 'status' : 'alert'}>{test.ok ? `OK. ${test.detail}` : test.detail}</p>}
      {note && <p className="field-note" role="status">{note}</p>}
      {error && <p className="set-error" role="alert">{error}</p>}
    </fieldset>
  );
}
