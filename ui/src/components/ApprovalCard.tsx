import type { ApprovalRequest } from '../../../src/shared/types';
import '../rooms/rooms.css';
import { openRoom, useRoomName } from '../rooms/roomsStore';
import { decide, useStore } from '../store';
import { shortTool } from '../util';
import { BlenderBadge, BlenderBody, blenderView, isBlenderExec } from '../blender/BlenderApproval';
import { BLENDER_ASSET_TOOL, GET_BLENDER_TOOL } from '../../../src/shared/blender';
import { Icon } from './icons';
import { clickOnly } from '../../../src/shared/approval-keys';

/** "Asked by Zealot in Launch crew, hop 2": shown when a bot woken inside a room needs approval. */
function Origin({ o, inRoomView }: { o: NonNullable<ApprovalRequest['origin']>; inRoomView: boolean }) {
  const from = useStore((s) => s.agents.find((x) => x.id === o.fromAgentId)?.name ?? o.fromAgentId);
  const viaBridge = o.roomId === 'agent-bridge';
  const viaMcp = o.roomId === 'mcp';
  const room = useRoomName(o.roomId);
  return (
    <div className="approval-origin">
      {viaMcp
        ? <span>Asked by <b>an MCP client</b> (Claude Code, Cowork or another tool using your access token)</span>
        : viaBridge
        ? <span>Asked by <b>{from}</b> through the agent bridge, hop {o.hop}</span>
        : <span>Asked by <b>{from}</b> in <b>{room ?? 'a room'}</b>, hop {o.hop}</span>}
      {!viaBridge && !viaMcp && !inRoomView && <button type="button" className="link-btn" onClick={() => openRoom(o.roomId)}>Open room</button>}
    </div>
  );
}

/** The card head: a room request reads as such, every other tool by its short name. */
const ROOM_REQUEST = /^mcp__legion_comms__room_(create|add_member|remove_member)$/;
const cardTool = (name: string): string => (ROOM_REQUEST.test(name) ? 'Room request' : name === GET_BLENDER_TOOL ? 'Download Blender' : name === BLENDER_ASSET_TOOL ? 'Download asset' : shortTool(name));

export function ApprovalCard({ a }: { a: ApprovalRequest }) {
  const inRoomView = useStore((s) => s.view === 'rooms');
  const bl = isBlenderExec(a);
  // a Blender script or a download is allowed by clicking, after reading the card: no one-key approve (the same rule as the thread-wide keys)
  const noKey = clickOnly(a);
  const bmode = bl ? blenderView(a).mode : 'sandbox';
  const live = bmode === 'live';
  return (
    <div className={`approval${bl ? ` blender${live ? ' is-live' : bmode === 'local' ? ' is-local' : ''}` : ''}`} tabIndex={0} role="group" aria-label={`Approval needed for ${cardTool(a.toolName)}`}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // a Blender script is allowed by clicking, after reading it: no one-key approve
        if (!noKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); void decide(a.id, true); }
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); void decide(a.id, false); }
      }}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span>Needs your OK</span>
        <b className="approval-tool">{cardTool(a.toolName)}</b>
        {bl && <BlenderBadge mode={bmode} />}
      </div>
      {a.origin && <Origin o={a.origin} inRoomView={inRoomView} />}
      {bl ? <BlenderBody a={a} /> : <pre className="approval-sum">{a.summary}</pre>}
      <div className="approval-actions">
        <button className="btn primary" onClick={() => void decide(a.id, true)}>Allow{!noKey && <> <kbd>A</kbd></>}</button>
        <button className="btn" onClick={() => void decide(a.id, false)}>Deny <kbd>D</kbd></button>
        <span className="approval-note">Auto-denies after 10 min</span>
      </div>
    </div>
  );
}
