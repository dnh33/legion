import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { useStore } from '../store';
import type { UsageRange, UsageRow, UsageSummary } from '../../../src/shared/usage-summary';
import { Icon } from './icons';
import '../styles/usage.css';

type Span = 'today' | 'days7' | 'days30';
const SPANS: ReadonlyArray<{ id: Span; label: string }> = [{ id: 'today', label: 'Today' }, { id: 'days7', label: '7 days' }, { id: 'days30', label: '30 days' }];

/** "$0.42", "<$0.01" for a real but tiny amount, "$0.00" for none, no decimals from $100 up. */
export const money = (n: number): string => (n <= 0 ? '$0.00' : n < 0.01 ? '<$0.01' : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Rows({ title, rows, name }: { title: string; rows: UsageRow[]; name: (k: string) => string }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.costUsd), 0.000001);
  return (
    <section className="usage-sec" aria-label={title}>
      <h5>{title}</h5>
      <ul>
        {rows.slice(0, 5).map((r) => (
          <li key={r.key}>
            <span className="usage-name" title={name(r.key)}>{name(r.key)}</span>
            <span className="usage-track" aria-hidden="true"><i style={{ width: `${Math.max(r.costUsd > 0 ? 4 : 0, (r.costUsd / max) * 100)}%` }} /></span>
            <span className="usage-val">{r.costUsd > 0 ? money(r.costUsd) : plural(r.tasks, 'task')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [err, setErr] = useState(false);
  const [span, setSpan] = useState<Span>('days7');
  const load = useCallback(async () => { try { setData(await request<UsageSummary>('GET', '/api/usage')); setErr(false); } catch { setErr(true); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.usage-btn')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('mousedown', down); window.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [onClose]);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const r: UsageRange | undefined = data?.[span];
  const maxDay = Math.max(...(data?.daily.map((d) => d.costUsd) ?? [0]), 0.000001);
  return (
    <div className="popover usage-pop" ref={box} role="dialog" aria-label="Claude usage">
      <div className="usage-head">
        <h4>Usage</h4>
        <div className="usage-seg" role="tablist" aria-label="Period">
          {SPANS.map((s) => <button key={s.id} type="button" role="tab" aria-selected={span === s.id} className={span === s.id ? 'on' : ''} onClick={() => setSpan(s.id)}>{s.label}</button>)}
        </div>
      </div>
      {!data && !err && <p className="usage-note">Loading{'…'}</p>}
      {err && !data && <p className="usage-note" role="alert">Could not load usage. Is the core running?</p>}
      {r && data && (
        <>
          <div className="usage-total">
            <b>{money(r.costUsd)}</b>
            <span>{plural(r.tasks, 'task')} · {plural(r.turns, 'turn')}</span>
          </div>
          <div className="usage-spark" role="img" aria-label={`Daily cost, last 14 days: ${data.daily.map((d) => `${d.day} ${money(d.costUsd)}`).join(', ')}`}>
            {data.daily.map((d, i) => <i key={d.day} className={i === data.daily.length - 1 ? 'now' : ''} title={`${d.day}: ${money(d.costUsd)}`} style={{ height: `${Math.max(d.costUsd > 0 ? 8 : 3, (d.costUsd / maxDay) * 100)}%` }} />)}
          </div>
          <div className="usage-axis" aria-hidden="true"><span>14 days ago</span><span>today</span></div>
          {r.tasks === 0
            ? <p className="usage-note">Nothing ran {span === 'today' ? 'today' : 'in this period'}. Usage appears here after a task has run.</p>
            : <><Rows title="By model" rows={r.byModel} name={(k) => k} /><Rows title="By agent" rows={r.byAgent} name={agentName} /></>}
          <p className="usage-foot">Claude{'’'}s own per-task cost figures, counted on the day each task last ran. A subscription does not bill per task, so read it as how much you used, not what you pay. Plan limits are not shown here.</p>
        </>
      )}
    </div>
  );
}

/** Title-bar icon that opens the usage panel on demand. Nothing is fetched until it is opened, and it closes on Esc or an outside click. */
export function UsageButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="usage-wrap">
      <button type="button" className={`icon-btn usage-btn${open ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label="Claude usage" title="Claude usage" onClick={() => setOpen((v) => !v)}><Icon name="chart" /></button>
      {open && <Panel onClose={close} />}
    </span>
  );
}
