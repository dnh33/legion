import { chipVisible, describeCounts, failureView, toggleCi, useCi } from './ciStore';
import './ci.css';

/**
 * Title-bar chip for CI: green (all passing), red (something failing) or running, with the counts for the current branch. Opens the CiPanel.
 * Hidden while the core knows no repository or has no GitHub client. Sits in .tb-right after the Blender chip. The words carry the state, so
 * colour is never the only signal; below 1100 px only the dot and the name stay.
 */
export function CiChip() {
  const visible = useCi(chipVisible);
  const summary = useCi((s) => s.summary);
  const open = useCi((s) => s.panelOpen);
  const fv = useCi((s) => failureView(s).active);
  const hidden = useCi((s) => { const v = failureView(s); return v.all > 0 && v.active === 0; });
  const problem = useCi((s) => s.runs?.problem ?? s.state?.problem ?? null);
  if (!visible) return null;
  const c = summary?.counts;
  const tone = problem && !fv ? 'warn' : fv ? 'bad' : c?.running ? 'run' : hidden ? 'idle' : c && c.success ? 'ok' : 'idle';
  const word = fv ? `${fv} failing` : c?.running ? `${c.running} running` : hidden ? 'No new failures' : c?.success ? 'Passing' : 'No runs';
  const shown = c && !fv && c.failure ? { ...c, failure: 0 } : c ? { ...c, failure: fv } : c;
  const full = `CI${summary?.branch ? ` on ${summary.branch}` : ''}: ${describeCounts(shown)}${hidden ? '. Earlier failures are dismissed' : ''}${problem ? '. Updates are paused or limited' : ''}`;
  return (
    <button type="button" className={`tb-ci tone-${tone}${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-label={`${full}. ${open ? 'Close' : 'Open'} the CI panel`} title={full} onClick={toggleCi}>
      <i className="tb-ci-dot" aria-hidden="true" />
      <span className="tb-ci-name">CI</span>
      <span className="tb-ci-word">{word}</span>
    </button>
  );
}
