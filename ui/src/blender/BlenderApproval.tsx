import type { ApprovalRequest } from '../../../src/shared/types';
import { BLENDER_EXEC_TOOL } from '../../../src/shared/blender';
import './blender.css';

export const isBlenderExec = (a: ApprovalRequest): boolean => a.toolName === BLENDER_EXEC_TOOL && typeof a.input?.script === 'string';

interface View { script: string; live: boolean; agentName: string; purpose: string; notes: string[]; lines: number; where: string; backup: string; exportDir: string; hash: string }

/** Reads the card input defensively: it comes from the core, but a card must never break on an odd value. */
export function blenderView(a: ApprovalRequest): View {
  const i = a.input as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const script = s(i.script);
  return {
    script, live: i.mode === 'live', agentName: s(i.agentName), purpose: s(i.purpose),
    notes: Array.isArray(i.notes) ? i.notes.filter((n): n is string => typeof n === 'string').slice(0, 12) : [],
    lines: typeof i.lines === 'number' ? i.lines : script.split('\n').length, where: s(i.where), backup: s(i.backup), exportDir: s(i.exportDir), hash: s(i.hash).slice(0, 12),
  };
}

export function BlenderBadge({ live }: { live: boolean }) {
  return live ? <span className="bl-badge live" title="Runs in your open Blender on this computer">Live</span> : <span className="bl-badge sandbox" title="Runs in a cloud VM, not on this computer">Sandbox</span>;
}

/** The body of the approval card for blender_exec: the FULL script in a code block, plus what the user needs to judge it. */
export function BlenderBody({ a }: { a: ApprovalRequest }) {
  const v = blenderView(a);
  const lines = v.script.split('\n');
  return (
    <>
      <div className="bl-facts">
        <span>Where <b>{v.where || (v.live ? 'LIVE Blender on your computer' : 'sandbox VM')}</b></span>
        {v.agentName && <span>From <b>{v.agentName}</b></span>}
        <span><b>{v.lines}</b> lines</span>
        {v.backup && <span>Backup <b>{v.backup}</b></span>}
        {v.hash && <span>sha256 <b>{v.hash}</b></span>}
      </div>
      {v.purpose && <p className="bl-purpose">{v.purpose}</p>}
      {v.live && <div className="bl-live-warn"><b>Live.</b> This runs in your open Blender with your files around it. The safety check is a filter, not a sandbox: read every line before you allow it.{v.exportDir ? ` Exports go to ${v.exportDir}.` : ''}</div>}
      <div className="bl-script" role="region" aria-label="Script to run" tabIndex={0}>
        <pre className="bl-gutter" aria-hidden="true">{lines.map((_, n) => n + 1).join('\n')}</pre>
        <pre className="bl-code">{v.script}</pre>
      </div>
      {v.notes.length > 0 && <ul className="bl-notes" aria-label="Notes from the safety check">{v.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </>
  );
}
