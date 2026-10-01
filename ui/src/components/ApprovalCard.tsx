import type { ApprovalRequest } from '../../../src/shared/types';
import { decide } from '../store';
import { shortTool } from '../util';
import { Icon } from './icons';

export function ApprovalCard({ a }: { a: ApprovalRequest }) {
  return (
    <div className="approval" tabIndex={0} role="group" aria-label={`Approval needed for ${shortTool(a.toolName)}`}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'a' || e.key === 'A') { e.preventDefault(); void decide(a.id, true); }
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); void decide(a.id, false); }
      }}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span>Needs your OK</span>
        <b className="approval-tool">{shortTool(a.toolName)}</b>
      </div>
      <pre className="approval-sum">{a.summary}</pre>
      <div className="approval-actions">
        <button className="btn primary" onClick={() => void decide(a.id, true)}>Allow <kbd>A</kbd></button>
        <button className="btn" onClick={() => void decide(a.id, false)}>Deny <kbd>D</kbd></button>
        <span className="approval-note">Auto-denies after 10 min</span>
      </div>
    </div>
  );
}
