import type { ApprovalRequest } from '../../../src/shared/types';
import '../rooms/rooms.css';
import { openRoom, useRoomName } from '../rooms/roomsStore';
import { useEffect, useState } from 'react';
import { decide, errText, rememberGate, toast, useStore } from '../store';
import { canRemember, canRememberAllow, rememberRule } from '../gates/gatesLogic';
import { shortTool } from '../util';
import { BlenderBadge, BlenderBody, blenderView, isBlenderExec } from '../blender/BlenderApproval';
import { BLENDER_ASSET_TOOL, GET_BLENDER_TOOL } from '../../../src/shared/blender';
import { Icon } from './icons';
import { clickOnly } from '../../../src/shared/approval-keys';
import { useArmUi, useCardArm } from '../a11y/keyClock';

/** "Asked by Marshal in Launch crew, hop 2": shown when a bot woken inside a room needs approval. */
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
  const [remember, setRemember] = useState(false);
  const arm = useCardArm(`approval:${a.id}`);
  const { armed, refresh } = useArmUi(arm);
  // an ignored key or click says so: the note while the card is not armed, and the same words once for a screen reader
  const [ignored, setIgnored] = useState(false);
  const [said, setSaid] = useState('');
  useEffect(() => { if (armed) setIgnored(false); }, [armed]);
  const notReady = (): void => { setIgnored(true); setSaid('Ready in a moment'); refresh(); };
  return (
    <div className={`approval${bl ? ` blender${live ? ' is-live' : bmode === 'local' ? ' is-local' : ''}` : ''}`} tabIndex={0} data-approval-id={a.id} data-armed={armed ? 'true' : 'false'} role="group" aria-label={`Approval needed for ${cardTool(a.toolName)}`}
      onFocus={(e) => arm.enterFrom(e.currentTarget, e.relatedTarget, performance.now())}
      onKeyDown={(e) => {
        // the card answers no key until it is armed (ARM_MS after it appeared or took focus from outside, and after the last key); a held key never answers
        const ok = arm.key(e.nativeEvent, e.key, e.repeat, performance.now());
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const decideKey = (!noKey && (e.key === 'a' || e.key === 'A')) || e.key === 'd' || e.key === 'D';
        if (decideKey && !ok) { if (!e.repeat) notReady(); return; }
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
        <button className="btn primary" data-tip="allow-button" onClick={(e) => { if (!arm.click(e.detail, performance.now())) { notReady(); return; } void decide(a.id, true); }}>Allow{!noKey && <> <kbd>A</kbd></>}</button>
        <button className="btn" onClick={(e) => { if (!arm.click(e.detail, performance.now())) { notReady(); return; } void decide(a.id, false); }}>Deny <kbd>D</kbd></button>
        {canRemember(a) && <button type="button" className="btn-ghost sm" aria-expanded={remember} onClick={() => setRemember((v) => !v)}>Remember…</button>}
        {ignored && !armed && <span className="approval-note">Ready in a moment</span>}
        <span className="sr-only" role="status" aria-live="polite">{said}</span>
        <span className="approval-note">Auto-denies after 10 min</span>
      </div>
      {remember && canRemember(a) && <RememberChoices a={a} />}
    </div>
  );
}

/** One click turns this answer into a gate rule (Settings → Gates lists it, labelled as from a card), then answers the card. */
export function RememberChoices({ a }: { a: ApprovalRequest }) {
  const agents = useStore((s) => s.agents);
  const nameOf = (id: string) => agents.find((x) => x.id === id)?.name ?? id;
  const allow = rememberRule(a, 'allow', nameOf);
  const deny = rememberRule(a, 'deny', nameOf);
  const [busy, setBusy] = useState(false);
  const save = async (rule: typeof allow, ok: boolean) => {
    setBusy(true);
    try { await rememberGate(rule); await decide(a.id, ok); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="approval-remember" role="group" aria-label="Remember this answer">
      {canRememberAllow(a) && <button type="button" className="btn sm" disabled={busy} onClick={() => void save(allow, true)}>Always allow: {allow.label}</button>}
      <button type="button" className="btn sm" disabled={busy} onClick={() => void save(deny, false)}>Always block: {deny.label}</button>
      <span className="approval-note">Saved as a gate (Settings, Gates). An allow never applies to a run another bot or Claude Code started.</span>
    </div>
  );
}
