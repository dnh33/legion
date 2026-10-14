import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../api';
import { errText, useStore } from '../store';
import type { SpendSummary } from '../../../src/shared/spend-view';
import { barHeights, dayLabel, money, SPEND_NOTE, spendRows, weekResetLabel } from './awayLogic';
import './away.css';

const REFRESH_MS = 30_000;

/** Settings, Spending: what was spent this week and today, by project and agent, and the last 14 days. Counted per run by the core's ledger. */
export function SpendingSection() {
  const [s, setS] = useState<SpendSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const projects = useStore((st) => st.projects);
  const agents = useStore((st) => st.agents);
  const load = useCallback(async () => {
    try { setS(await request<SpendSummary>('GET', '/api/spend?scope=app')); setErr(null); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), REFRESH_MS); return () => window.clearInterval(t); }, [load]);

  const projectNames = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  const agentNames = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.name])), [agents]);
  const byProject = s ? spendRows(s.byProject, projectNames, 'No project', 'A removed project') : [];
  const byAgent = s ? s.byAgent.map((a) => ({ id: a.agentId, label: agentNames[a.agentId] ?? 'A removed agent', usd: a.usd })) : [];
  const heights = s ? barHeights(s.daily) : [];

  return (
    <div className="set-section away-section">
      <header className="set-head"><h3>Spending</h3><p>What your agents cost, across all projects.</p></header>
      {err && <p className="set-error" role="alert">{err}</p>}
      {!s && !err && <div className="set-loading"><span className="spin" /> Loading{'…'}</div>}
      {s && (
        <>
          <div className="spend-totals">
            <div><span className="spend-big">{money(s.week)}</span><span className="set-hint">This week. {weekResetLabel(Date.now())}</span></div>
            <div><span className="spend-big">{money(s.today)}</span><span className="set-hint">Today</span></div>
          </div>
          <SpendList title="By project, this week" rows={byProject} total={s.week} empty="Nothing spent yet this week." />
          <SpendList title="By agent, this week" rows={byAgent} total={s.week} empty="Nothing spent yet this week." />
          <section aria-label="Last 14 days">
            <h4 className="spend-h">Last 14 days</h4>
            <ol className="spend-days">
              {s.daily.map((d, i) => (
                <li key={d.day} aria-label={`${dayLabel(d.day, true)}: ${money(d.usd)}`} title={`${dayLabel(d.day, true)}: ${money(d.usd)}`}>
                  <span className="spend-bar-wrap"><span className={`spend-bar${i === s.daily.length - 1 ? ' today' : ''}`} style={{ height: `${heights[i]}%` }} /></span>
                  <span className="spend-day">{i === 0 || i === s.daily.length - 1 ? dayLabel(d.day, true) : dayLabel(d.day)}</span>
                </li>
              ))}
            </ol>
          </section>
          <p className="set-hint">{SPEND_NOTE}</p>
        </>
      )}
    </div>
  );
}

function SpendList({ title, rows, total, empty }: { title: string; rows: Array<{ id: string; label: string; usd: number }>; total: number; empty: string }) {
  return (
    <section aria-label={title}>
      <h4 className="spend-h">{title}</h4>
      {rows.length === 0 ? <p className="set-hint">{empty}</p> : (
        <ul className="spend-rows">
          {rows.map((r) => (
            <li key={r.id || r.label}>
              <span className="spend-name">{r.label}</span>
              <span className="spend-track" aria-hidden="true"><span style={{ width: `${total > 0 ? Math.max(2, Math.round((r.usd / total) * 100)) : 0}%` }} /></span>
              <span className="spend-usd">{money(r.usd)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
