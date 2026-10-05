import type { ApprovalRequest } from '../../../src/shared/types';
import '../rooms/rooms.css';
import { openRoom, useRoomName } from '../rooms/roomsStore';
import { decide, useStore } from '../store';
import { shortTool } from '../util';
import { BlenderBadge, BlenderBody, blenderView, isBlenderExec } from '../blender/BlenderApproval';
import { BLENDER_ASSET_TOOL, BLENDER_EXEC_TOOL, GET_BLENDER_TOOL } from '../../../src/shared/blender';
import { Icon } from './icons';
import { clickOnly } from '../../../src/shared/approval-keys';

/**
 * Who started the run that is asking, when it was not you: "Via Zealot in Launch crew, hop 2". The bot that asks is named in the head; this
 * line names the one whose message woke it, so the two are never confused.
 */
function Origin({ o, inRoomView }: { o: NonNullable<ApprovalRequest['origin']>; inRoomView: boolean }) {
  const from = useStore((s) => s.agents.find((x) => x.id === o.fromAgentId)?.name ?? o.fromAgentId);
  const viaBridge = o.roomId === 'agent-bridge';
  const viaMcp = o.roomId === 'mcp';
  const room = useRoomName(o.roomId);
  return (
    <div className="approval-origin">
      {viaMcp
        ? <span>Via <b>an MCP client</b> (Claude Code, Cowork or another tool using your access token)</span>
        : viaBridge
        ? <span>Via <b>{from}</b> through the agent bridge, hop {o.hop}</span>
        : <span>Via <b>{from}</b> in <b>{room ?? 'a room'}</b>, hop {o.hop}</span>}
      {!viaBridge && !viaMcp && !inRoomView && <button type="button" className="link-btn" onClick={() => openRoom(o.roomId)}>Open room</button>}
    </div>
  );
}

/** The card head names the tool in plain words for Legion's own card kinds; any other tool by its short name. The full id is the tooltip. */
const ROOM_REQUEST = /^mcp__legion_comms__room_(create|add_member|remove_member)$/;
const PLAIN: Record<string, string> = {
  [GET_BLENDER_TOOL]: 'Download Blender',
  [BLENDER_ASSET_TOOL]: 'Download asset',
  [BLENDER_EXEC_TOOL]: 'Blender script',
  mcp__legion_board__delete: 'Delete board item',
  mcp__legion_browser__browser_open: 'Open web page',
  mcp__legion_browser__browser_eval: 'Script in web page',
};
const cardTool = (name: string): string => (ROOM_REQUEST.test(name) ? 'Room request' : PLAIN[name] ?? shortTool(name));
/** Text Legion wrote out in sentences reads as prose; a command, a path, a script or JSON stays in the code face, character for character. */
const PROSE = (name: string): boolean => ROOM_REQUEST.test(name) || name === 'mcp__legion_board__delete';

export function ApprovalCard({ a }: { a: ApprovalRequest }) {
  const inRoomView = useStore((s) => s.view === 'rooms');
  // the managed Blender download is asked for by you, from Settings: it carries the Sculptor's id only as a technical owner, so no bot is named
  const askedByYou = a.toolName === GET_BLENDER_TOOL;
  const who = useStore((s) => (askedByYou ? 'You, from Settings' : s.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId));
  const bl = isBlenderExec(a);
  // a Blender script or a download is allowed by clicking, after reading the card: no one-key approve (the same rule as the thread-wide keys)
  const noKey = clickOnly(a);
  const bmode = bl ? blenderView(a).mode : 'sandbox';
  const live = bmode === 'live';
  const risky = bl && bmode !== 'sandbox';
  return (
    <div className={`approval${bl ? ` blender${live ? ' is-live' : bmode === 'local' ? ' is-local' : ''}` : ''}${risky ? ' is-risky' : ''}`} tabIndex={0} role="group" aria-label={`Needs your OK: ${cardTool(a.toolName)}, asked by ${who}`}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // a Blender script is allowed by clicking, after reading it: no one-key approve
        if (!noKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); void decide(a.id, true); }
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); void decide(a.id, false); }
      }}>
      <div className="approval-head">
        <Icon name="shield" size={14} />
        <span className="approval-ask">Needs your OK</span>
        <span className="approval-who">{who}</span>
        <b className="approval-tool" title={a.toolName}>{cardTool(a.toolName)}</b>
        {bl && <BlenderBadge mode={bmode} />}
      </div>
      {a.origin && <Origin o={a.origin} inRoomView={inRoomView} />}
      {bl ? <BlenderBody a={a} /> : <pre className={`approval-sum${PROSE(a.toolName) ? ' prose' : ''}`}>{a.summary}</pre>}
      <div className="approval-actions">
        <button className="btn primary" onClick={() => void decide(a.id, true)}>Allow{!noKey && <> <kbd>A</kbd></>}</button>
        <button className="btn" onClick={() => void decide(a.id, false)}>Deny <kbd>D</kbd></button>
        <span className="approval-note">{noKey && <span className="approval-click">No shortcut allows this: read it, then press Allow. </span>}Auto-denies after 10 min</span>
      </div>
    </div>
  );
}
