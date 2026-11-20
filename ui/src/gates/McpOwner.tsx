// Settings, Gates: the switch "MCP clients act as you". Off by default; turning it on goes through the app's native confirmation like every loosening.
// The view takes everything as props (a test draws every state); the wired card sends the change.
import { GatesNote } from './GatesPresets';
import type { GatesView } from './presetsLogic';
import type { GatesChangeRequest, GatesNote as Note } from './gatesAction';
import './gates.css';
import { MCP_OWNER_LABEL, MCP_OWNER_NO_KEY, MCP_OWNER_OFF_TEXT, MCP_OWNER_ON_TEXT } from './mcpOwnerCopy';

export { MCP_OWNER_LABEL, MCP_OWNER_NO_KEY, MCP_OWNER_OFF_TEXT, MCP_OWNER_ON_TEXT };

export const mcpOwnerOn = (view: GatesView): boolean => view.app.mcpActsAsOwner === true;

/** The card under "How agents ask", next to Claude's own checks. */
export function McpOwnerCardView({ view, busy, note, onToggle }: { view: GatesView; busy: boolean; note: Note | null; onToggle: (on: boolean) => void }) {
  const on = mcpOwnerOn(view);
  // Turning it on loosens, so it needs the signing key; turning it off never does.
  const noKey = !on && !view.canSign;
  return (
    <div className="set-card gates-mcp-owner" aria-label="MCP clients">
      <label className="gates-row gates-choice">
        <input type="checkbox" role="switch" checked={on} disabled={busy || noKey} onChange={(e) => onToggle(e.target.checked)} />
        <span><b>{MCP_OWNER_LABEL}</b>
          <span className="field-note">{on ? MCP_OWNER_ON_TEXT : MCP_OWNER_OFF_TEXT}</span>
          {noKey && <span className="field-note">{MCP_OWNER_NO_KEY}</span>}
        </span>
      </label>
      <GatesNote note={note} pending={busy} />
    </div>
  );
}

export function McpOwnerCard({ view, busy, note, run }: { view: GatesView; busy: boolean; note: Note | null; run: (c: GatesChangeRequest, done: string) => Promise<boolean> }) {
  return (
    <McpOwnerCardView view={view} busy={busy} note={note}
      onToggle={(on) => void run({ kind: 'app', patch: { mcpActsAsOwner: on } }, on ? 'MCP clients now act as you.' : 'MCP clients are limited again.')} />
  );
}
