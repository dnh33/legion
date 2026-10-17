import { useEffect, useState } from 'react';
import type { Project } from '../../../src/shared/projects';
import type { Task } from '../../../src/shared/types';
import { errText } from '../store';
import { Icon } from '../components/icons';
import { loadActivity, type ActivityRow } from './useGatesView';

const PAGE = 100;
const MAX = 1000;
const KINDS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'run-start,run-end', label: 'Runs' },
  { id: 'card-asked,card-answered', label: 'Cards' },
  { id: 'would-have-asked', label: 'Would have asked' },
  { id: 'gate-changed', label: 'Gate changes' },
  { id: 'goal-state,check-verdict', label: 'Goals and checks' },
  { id: 'web-call', label: 'Web' },
];

const when = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; };

/** Settings, Gates, Activity: what ran and what the gates did, newest first. A line for a gate that is off says what it would have asked. */
export function ActivityView({ projects, tasks }: { projects: readonly Project[]; tasks: readonly Task[] }) {
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [kind, setKind] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadActivity({ ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}), ...(kind ? { kinds: kind.split(',') } : {}), limit })
      .then((r) => { if (live) { setRows(r); setError(null); } }, (e: unknown) => { if (live) setError(errText(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, taskId, kind, limit]);
  const reset = () => setLimit(PAGE);
  const recent = [...tasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, 30);
  const canMore = rows !== null && rows.length >= limit && limit < MAX;
  return (
    <div className="set-card gates-activity" aria-label="Activity">
      <h3>Activity</h3>
      <div className="gates-filters">
        <label>Project
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); reset(); }}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Run
          <select value={taskId} onChange={(e) => { setTaskId(e.target.value); reset(); }}>
            <option value="">All runs</option>
            {recent.map((t) => <option key={t.id} value={t.id}>{(t.title || t.id).slice(0, 60)}</option>)}
          </select>
        </label>
        <label>Kind
          <select value={kind} onChange={(e) => { setKind(e.target.value); reset(); }}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="set-error" role="alert"><Icon name="x" size={13} /> <span>{error}</span></div>}
      {!error && rows === null && <p className="muted-s" role="status">Loading activity</p>}
      {!error && rows !== null && rows.length === 0 && <p className="muted-s">Nothing here yet. Runs, cards and gate changes appear as they happen.</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="gates-log">
          {rows.map((r, i) => (
            <li key={`${r.at}-${i}`} className={`gates-row gates-log-line${r.kind === 'would-have-asked' ? ' warn' : ''}`}>
              <time dateTime={r.at}>{when(r.at)}</time>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      {canMore && <div className="set-actions"><button type="button" className="btn" disabled={loading} onClick={() => setLimit((n) => Math.min(MAX, n + PAGE))}>Load more</button></div>}
    </div>
  );
}
