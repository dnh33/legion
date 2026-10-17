/**
 * Settings → Armory → Skill finder: the switches for the three ways an agent finds a skill (a suggestion each turn, a search tool, a short
 * skill list), how skills are ranked, and a test box that shows the ranking for a message you type.
 *
 * Every setting is the owner's, saved at once (optimistic, put back with the reason on a failure). The strings that carry a promise or a
 * disclosure are fixed here; nothing is sent anywhere until a switch or a ranker that sends it is chosen.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/icons';
import { RERANK_LATENCY_NOTE } from '../../../src/core/armory/finder/defaults';
import { endSentence, isLocalHostUrl, PROVIDER_DISCLOSURE, PROVIDER_DISCLOSURE_LOCAL } from '../../../src/shared/armory-view';
import type { AgentRef, FinderSettings } from '../../../src/shared/armory-view';
import { getProviders, loadProviders, useProviders } from '../providers/providersStore';
import {
  checkFinderModelAgain, dismissFinderNotice, getFinderModel, loadFinderModel, loadRerankSpend, removeFinderModel, say, setFinder, stopFinderModelPoll, testFinder, useArmory,
} from './armoryStore';
import type { FinderTestResult } from './armoryStore';

export const FINDER_NOTICE = 'Legion now lists your skills briefly and lets agents search for the one that fits. With many skills on, each message stays smaller.';
const SUGGEST_HELP = 'Off by default: in tests, a suggestion picked the right skill less than half the time.';
const SLIM_HELP = "Sends each skill's name with a short description, and agents search for the rest. Saves the most when many skills are on.";
const SLIM_NEEDS = 'Needs the search tool.';
const RERANK_DISCLOSURE = "Uses your Claude account. Provider agents' messages are never sent.";
const NO_PROVIDER = 'No embedding provider set up';
const AUTO_NEEDS_LOCAL = "Pick 'Keywords + local model' below for this to suggest anything.";
const CAP_ERROR = 'Enter an amount of 0 or more';
const WAITING = 'Still waiting for approval. Check the approval card.';
const TEST_EMPTY = 'Type a message to see which skills fit it';
const TEST_NONE = 'No skill matched any word or meaning in this message';
const MODEL_GET = 'Get model';
const MODEL_FACTS = 'About 145 MB download. Uses about 1 GB of memory while in use.';

type SuggestValue = 'false' | 'true' | 'auto';
const suggestValue = (v: FinderSettings['suggest']): SuggestValue => (v === 'auto' ? 'auto' : v ? 'true' : 'false');
const money = (n: number): string => (n > 0 && n < 0.005 ? 'less than $0.01' : `$${n.toFixed(2)}`);

/** A switch in the Armory's own markup (the same as Advanced), with a label that names its action. */
function Switch({ label, on, disabled, describedBy, onChange }: { label: string; on: boolean; disabled?: boolean; describedBy?: string; onChange: (v: boolean) => void }) {
  return (
    <label className={`house-sw${disabled ? ' arm-swdis' : ''}`}>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} aria-label={label} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span className="house-swtrack" aria-hidden="true"><i /></span>
      <span className="house-swtext">{on ? 'On' : 'Off'}</span>
    </label>
  );
}

/** One setting: its name and help on the left, the control on the right (below, when the column is narrow). */
function Row({ label, help, id, control, children }: { label: string; help?: React.ReactNode; id: string; control: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="arm-frow">
      <div className="arm-ftext">
        <p className="arm-flabel" id={`${id}-l`}>{label}</p>
        {help ? <p className="set-hint" id={`${id}-h`}>{help}</p> : null}
      </div>
      <div className="arm-fctl">{control}</div>
      {children ? <div className="arm-fextra">{children}</div> : null}
    </div>
  );
}

export function SkillFinder({ agents }: { agents: readonly AgentRef[] }) {
  const f = useArmory((s) => s.data?.finder);
  const err = useArmory((s) => s.finderError);
  const hid = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [capText, setCapText] = useState<string | null>(null);
  const [capErr, setCapErr] = useState(false);
  // Closing the section stops the progress polling (the download itself goes on in the core).
  useEffect(() => () => stopFinderModelPoll(), []);
  useEffect(() => { void loadFinderModel(); void loadRerankSpend(); if (!getProviders().loaded) void loadProviders(); }, []);
  if (!f) return null;
  const id = (k: string): string => `${hid}-${k}`;
  const slimValue = !f.searchTool ? 'false' : String(f.slimListing);

  return (
    <section className="arm-fnd" aria-labelledby={`${hid}-h`}>
      <h4 id={`${hid}-h`} ref={heading} tabIndex={-1} className="house-h">Skill finder</h4>
      <p className="set-hint arm-fintro">Helps an agent find the right skill when many are on. Each part can be switched off.</p>

      {!f.noticeSeen ? (
        <section className="arm-notice" aria-label="Skill finder">
          <p>{FINDER_NOTICE}</p>
          <div className="arm-noticebtns">
            <button type="button" className="btn sm primary" onClick={() => { void dismissFinderNotice(false).then((ok) => { if (ok) { say('Kept. You can change this below.'); heading.current?.focus(); } }); }}>Keep</button>
            <button type="button" className="btn sm" onClick={() => { void dismissFinderNotice(true).then((ok) => { if (ok) { say('Agents get the full skill list.'); heading.current?.focus(); } }); }}>Use the full list</button>
          </div>
        </section>
      ) : null}

      <div className="arm-flist">
        <Row id={id('suggest')} label="Suggest each turn" help={SUGGEST_HELP}
          control={(
            <select aria-labelledby={`${id('suggest')}-l`} aria-describedby={`${id('suggest')}-h`} value={suggestValue(f.suggest)}
              onChange={(e) => { const v = e.target.value as SuggestValue; void setFinder({ suggest: v === 'auto' ? 'auto' : v === 'true' }); }}>
              <option value="false">Off</option>
              <option value="true">On</option>
              <option value="auto">Only with the local model</option>
            </select>
          )}>
          {f.suggest === 'auto' && f.ranker !== 'local' ? <p className="set-hint arm-fdisc">{AUTO_NEEDS_LOCAL}</p> : null}
        </Row>

        <Row id={id('search')} label="Search tool" help="Lets an agent search your skills by what it wants to do."
          control={<Switch label="Search tool" on={f.searchTool} describedBy={`${id('search')}-h`} onChange={(v) => { void setFinder({ searchTool: v }); }} />} />

        <Row id={id('slim')} label="Short skill list" help={<>{SLIM_HELP}{!f.searchTool ? <> <span className="arm-needs">{SLIM_NEEDS}</span></> : null}</>}
          control={(
            <select aria-labelledby={`${id('slim')}-l`} aria-describedby={`${id('slim')}-h`} value={slimValue} disabled={!f.searchTool}
              onChange={(e) => { const v = e.target.value; void setFinder({ slimListing: v === 'auto' ? 'auto' : v === 'true' }); }}>
              <option value="auto">When an agent has more than 40 skills</option>
              <option value="true">Always</option>
              <option value="false">Never</option>
            </select>
          )} />

        <Ranker f={f} id={id('rank')} />

        <Row id={id('rerank')} label="Rerank close calls with Haiku" help={RERANK_LATENCY_NOTE}
          control={<Switch label="Rerank close calls with Haiku" on={f.rerank} describedBy={`${id('rerank')}-h`} onChange={(v) => { void setFinder({ rerank: v }).then((ok) => { if (ok && v) void loadRerankSpend(); }); }} />}>
          <div className={`arm-rrx${f.rerank ? '' : ' arm-fmuted'}`}>
          <Spend />
          <label className="arm-cap">
            <span>Monthly cap</span>
            <span className="arm-capin"><span aria-hidden="true">$</span>
              <input type="text" inputMode="decimal" size={5} value={capText ?? String(f.rerankMonthlyUsd)} aria-invalid={capErr || undefined} aria-describedby={capErr ? `${id('rerank')}-e` : undefined}
                onChange={(e) => { setCapText(e.target.value); setCapErr(false); }}
                onBlur={() => {
                  if (capText === null) return;
                  const t = capText.trim().replace(',', '.');
                  const n = t === '' ? NaN : Number(t);
                  // Text that is not an amount, or a negative one, is said so and stays on screen; it is not sent and not put back silently.
                  if (!Number.isFinite(n) || n < 0) { setCapErr(true); return; }
                  setCapErr(false); setCapText(null);
                  if (n !== f.rerankMonthlyUsd) void setFinder({ rerankMonthlyUsd: n }).then(() => loadRerankSpend());
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </span>
          </label>
          {capErr ? <p className="house-rowerr" id={`${id('rerank')}-e`} role="alert"><Icon name="x" size={12} /> <span>{CAP_ERROR}</span></p> : null}
          </div>
          <p className="set-hint arm-fdisc">{RERANK_DISCLOSURE}</p>
        </Row>


        <p className="arm-fgrouph set-hint">Used when Suggest each turn is on.</p>
        <div className={`arm-fgroup${f.suggest === false ? ' arm-fmuted' : ''}`}>
        <Row id={id('sub')} label="Subagent suggestions" help="Also suggests skills to the helpers an agent starts."
          control={<Switch label="Subagent suggestions" on={f.subagents} describedBy={`${id('sub')}-h`} onChange={(v) => { void setFinder({ subagents: v }); }} />} />

        <Row id={id('k')} label="Skills per suggestion" help="How many skills one suggestion names."
          control={(
            <select aria-labelledby={`${id('k')}-l`} aria-describedby={`${id('k')}-h`} value={f.k} onChange={(e) => { void setFinder({ k: Number(e.target.value) }); }}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )} />

        <Row id={id('thr')} label="How sure a match must be" help="Strict suggests less often, and only when sure. Eager suggests more, with more wrong picks."
          control={(
            <select aria-labelledby={`${id('thr')}-l`} aria-describedby={`${id('thr')}-h`} value={f.threshold} onChange={(e) => { void setFinder({ threshold: e.target.value as FinderSettings['threshold'] }); }}>
              <option value="strict">Strict</option>
              <option value="balanced">Balanced</option>
              <option value="eager">Eager</option>
            </select>
          )} />

        <Row id={id('chat')} label="Show suggestions in chat" help="A quiet line under the reply names the skills that were suggested and the ones that were loaded."
          control={<Switch label="Show suggestions in chat" on={f.chatLine} describedBy={`${id('chat')}-h`} onChange={(v) => { void setFinder({ chatLine: v }); }} />} />
        </div>
      </div>

      {err ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(`Could not save: ${err}`)} The setting is as it was.</span></p> : null}

      <TestBox agents={agents} />
    </section>
  );
}

/** The ranker select, with the local model card or the provider choice under it. */
function Ranker({ f, id }: { f: FinderSettings; id: string }) {
  // Select the stored view (stable), not a new array: a selector that returns a fresh array every call loops forever.
  const view = useProviders((s) => s.view);
  const providers = useMemo(() => (view?.providers ?? []).filter((p) => p.enabled), [view]);
  const none = providers.length === 0;
  return (
    <Row id={id} label="How skills are ranked" help="Keywords is built in. A model can also match meaning, not only words."
      control={(
        <select aria-labelledby={`${id}-l`} aria-describedby={`${id}-h`} value={f.ranker} onChange={(e) => { void setFinder({ ranker: e.target.value as FinderSettings['ranker'] }); }}>
          <option value="keyword">Keywords</option>
          <option value="local">Keywords + local model</option>
          <option value="provider" disabled={none && f.ranker !== 'provider'}>Keywords + provider embeddings{none ? ` (${NO_PROVIDER.toLowerCase()})` : ''}</option>
        </select>
      )}>
      {f.ranker === 'provider' ? <ProviderPick f={f} id={id} providers={providers.map((p) => ({ id: p.id, label: p.label, models: p.models, baseUrl: p.baseUrl }))} /> : null}
      <ModelCard show={f.ranker === 'local'} />
    </Row>
  );
}

function ProviderPick({ f, id, providers }: { f: FinderSettings; id: string; providers: { id: string; label: string; models: string[]; baseUrl: string }[] }) {
  const [model, setModel] = useState<string | null>(null);
  if (providers.length === 0) return <p className="set-hint arm-fdisc">{NO_PROVIDER}</p>;
  const cur = providers.find((p) => p.id === f.providerId);
  const commit = (): void => { const v = (model ?? '').trim(); if (model !== null && v !== (f.providerModel ?? '')) void setFinder({ providerModel: v }); setModel(null); };
  return (
    <div className="arm-prov">
      <div className="arm-provrow">
        <label className="arm-provf"><span>Provider</span>
          <select value={f.providerId ?? ''} onChange={(e) => { void setFinder({ providerId: e.target.value }); }}>
            <option value="">Choose a provider</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="arm-provf"><span>Embedding model</span>
          <input type="text" list={`${id}-models`} value={model ?? f.providerModel ?? ''} placeholder="Model name from your provider" onChange={(e) => setModel(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <datalist id={`${id}-models`}>{(cur?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        </label>
      </div>
      <p className="set-hint arm-fdisc">{cur && isLocalHostUrl(cur.baseUrl) ? PROVIDER_DISCLOSURE_LOCAL : PROVIDER_DISCLOSURE}</p>
      {!(f.providerId && f.providerModel) ? <p className="set-hint arm-fdisc">Until a provider and a model are chosen, skills are ranked by keywords.</p> : null}
    </div>
  );
}

/** The local model: not installed (Get), getting it, ready (Remove), or a plain error (Try again). One element holds focus across the changes. */
function ModelCard({ show }: { show: boolean }) {
  const m = useArmory((s) => s.model);
  const busy = useArmory((s) => s.modelBusy);
  const err = useArmory((s) => s.modelError);
  const waiting = useArmory((s) => s.modelWaiting);
  const card = useRef<HTMLDivElement>(null);
  const [ask, setAsk] = useState(false);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const removeBtn = useRef<HTMLButtonElement>(null);
  const was = useRef(false);
  // Focus follows the inline step: onto Cancel when it opens (the safe choice), back onto Remove when it closes without removing.
  useEffect(() => { if (ask) cancelBtn.current?.focus(); else if (was.current) removeBtn.current?.focus(); was.current = ask; }, [ask]);
  if (!m || (!show && m.state === 'not-installed')) return null;
  const go = (fn: () => Promise<void>) => () => { if (busy) return; card.current?.focus(); void fn().then(() => card.current?.focus()); };
  const pct = m.state === 'downloading' && m.progress ? Math.round(m.progress * 100) : 0;
  const message = err ?? (m.state === 'error' ? m.error : undefined);
  return (
    <div className="arm-model" ref={card} tabIndex={-1} aria-label="Local model">
      {m.state === 'not-installed' ? (
        <>
          <button type="button" className="btn sm arm-nowrap" aria-disabled={busy || undefined} onClick={go(getFinderModel)}>{message ? 'Try again' : MODEL_GET}</button>
          <p className="set-hint">{MODEL_FACTS} Until the model is ready, skills are ranked by keywords.</p>
        </>
      ) : null}
      {m.state === 'downloading' ? (
        waiting ? (
          <p className="arm-modelline" role="status"><span>{WAITING}</span> <button type="button" className="btn-ghost sm" onClick={() => { void checkFinderModelAgain(); }}>Check again</button></p>
        ) : (
          <p className="arm-modelline" role="status"><span className="spin" aria-hidden="true" /> <span>Getting the model (about 145 MB){pct ? `, ${pct}% done` : ''}. Approve it in the approval card if you see one.</span></p>
        )
      ) : null}
      {m.state === 'ready' ? (
        ask ? (
          <p className="arm-modelline" role="group" aria-label="Remove the model">
            <span>Remove the model? You can download it again.</span>
            <button type="button" className="btn sm" onClick={() => { setAsk(false); go(removeFinderModel)(); }}>Remove</button>
            <button ref={cancelBtn} type="button" className="btn-ghost sm" onClick={() => setAsk(false)}>Cancel</button>
          </p>
        ) : (
          <p className="arm-modelline"><Icon name="check" size={12} /> <span>Ready{m.bytes ? ` (${Math.round(m.bytes / 1_000_000)} MB on your computer)` : ''}</span>
            <button ref={removeBtn} type="button" className="btn-ghost sm" aria-disabled={busy || undefined} onClick={() => { if (!busy) setAsk(true); }}>Remove</button></p>
        )
      ) : null}
      {m.state === 'error' ? (
        <button type="button" className="btn sm" aria-disabled={busy || undefined} onClick={go(getFinderModel)}>Try again</button>
      ) : null}
      {message ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(message)}</span></p> : null}
    </div>
  );
}

function Spend() {
  const s = useArmory((x) => x.spend);
  if (!s) return null;
  return <p className="arm-spend">This month: {money(s.spentUsd)} of {money(s.capUsd)}</p>;
}

/** Type a message and see the ranking the search tool would give: the same code ranks it on the core. */
function TestBox({ agents }: { agents: readonly AgentRef[] }) {
  const hid = useId();
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<FinderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (e: React.FormEvent): void => {
    e.preventDefault();
    if (busy) return;
    if (!query.trim()) { setError(null); setRes(null); return; }
    setBusy(true); setError(null);
    testFinder(query.trim(), agent || undefined)
      .then((r) => setRes(r), (x: unknown) => setError(x instanceof Error ? x.message : String(x)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="arm-tbox" role="group" aria-labelledby={`${hid}-h`}>
      <h5 id={`${hid}-h`} className="arm-subh">Try a message</h5>
      <p className="set-hint arm-fintro">Ranked as the search tool ranks.</p>
      <form className="arm-tform" onSubmit={run}>
        <label className="house-search arm-tq">
          <Icon name="search" size={13} />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Message to test" placeholder="A message you might send" autoComplete="off" />
        </label>
        <label className="arm-tag"><span className="arm-tagl">For</span>
          <select aria-label="Whose skills to rank" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Every skill that is on</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <button type="submit" className="btn sm" aria-disabled={busy || undefined}>{busy ? <>Testing{'…'}</> : 'Test'}</button>
      </form>
      {error ? <p className="house-rowerr" role="alert"><Icon name="x" size={12} /> <span>{endSentence(error)}</span></p> : null}
      {!res && !error ? <p className="set-hint">{TEST_EMPTY}</p> : null}
      {res && res.rows.length === 0 ? <p className="set-hint" role="status">{TEST_NONE}</p> : null}
      {res && res.rows.length > 0 ? (
        <>
          <p className="set-hint" role="status">Top {res.rows.length} of {res.candidates} skill{res.candidates === 1 ? '' : 's'} for this message.</p>
          <table className="arm-ttable">
            <thead><tr><th scope="col">Rank</th><th scope="col">Skill</th><th scope="col">Score</th><th scope="col">Why</th></tr></thead>
            <tbody>
              {res.rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="rk">{i + 1}</td>
                  <td className="id"><code>{r.id}</code>{r.thirdParty ? <span className="arm-faint"> third-party</span> : null}</td>
                  <td className="sc">{r.score.toFixed(2)}</td>
                  <td className="why">{whyOf(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

/** matched words · cosine · boost. */
export function whyOf(r: { matched: string[]; cosine?: number; boost: number }): string {
  const parts: string[] = [];
  if (r.matched.length) parts.push(`matched ${r.matched.join(', ')}`);
  if (r.cosine !== undefined) parts.push(`meaning ${r.cosine.toFixed(2)}`);
  if (r.boost !== 1) parts.push(`used before ${r.boost.toFixed(2)}x`);
  return parts.length ? parts.join(' · ') : 'no matched words';
}
