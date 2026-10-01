import type { ApprovalRequest } from '../../../src/shared/types';
import '../rooms/rooms.css';
import { openRoom, useRoomName } from '../rooms/roomsStore';
import { decide, useStore } from '../store';
import { shortTool } from '../util';
import { Icon } from './icons';

/** "Asked by Zealot in Launch crew, hop 2": shown when a bot woken inside a room needs approval. */
function Origin({ o, inRoomView }: { o: NonNullable<ApprovalRequest['origin']>; inRoomView: boolean }) {
  const from = useStore((s) => s.agents.find((x) => x.id === o.fromAgentId)?.name ?? o.fromAgentId);
  const room = useRoomName(o.roomId);
  return (
    <div className="approval-origin">
      <span>Asked by <b>{from}</b> in <b>{room ?? 'a room'}</b>, hop {o.hop}</span>
      {!inRoomView && <button type="button" className="link-btn" onClick={() => openRoom(o.roomId)}>Open room</button>}
    </div>
  );
}

export function ApprovalCard({ a }: { a: ApprovalRequest }) {
  const inRoomView = useStore((s) => s.view === 'rooms');
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
      {a.origin && <Origin o={a.origin} inRoomView={inRoomView} />}
      <pre className="approval-sum">{a.summary}</pre>
      <div className="approval-actions">
        <button className="btn primary" onClick={() => void decide(a.id, true)}>Allow <kbd>A</kbd></button>
        <button className="btn" onClick={() => void decide(a.id, false)}>Deny <kbd>D</kbd></button>
        <span className="approval-note">Auto-denies after 10 min</span>
      </div>
    </div>
  );
}
