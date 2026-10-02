import type { ApprovalRequest } from '../../../src/shared/types';
import { BLENDER_EXEC_TOOL } from '../../../src/shared/blender';
import { LOCAL_CARD_WARN, localCardExports } from './copy';
import './blender.css';

export const isBlenderExec = (a: ApprovalRequest): boolean => a.toolName === BLENDER_EXEC_TOOL && typeof a.input?.script === 'string';

export type CardMode = 'live' | 'local' | 'sandbox';
interface View { script: string; live: boolean; mode: CardMode; agentName: string; purpose: string; notes: string[]; where: string; backup: string; exportDir: string; hash: string }

/** Reads the card input defensively: it comes from the core, but a card must never break on an odd value. */
export function blenderView(a: ApprovalRequest): View {
  const i = a.input as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    script: s(i.script), live: i.mode === 'live', mode: i.mode === 'live' ? 'live' : i.mode === 'local' ? 'local' : 'sandbox', agentName: s(i.agentName), purpose: s(i.purpose),
    notes: Array.isArray(i.notes) ? i.notes.filter((n): n is string => typeof n === 'string').slice(0, 12) : [],
    where: s(i.where), backup: s(i.backup), exportDir: s(i.exportDir), hash: s(i.hash).slice(0, 12),
  };
}

/**
 * The same line breaks Python uses (and the static check counts with): \r\n, a lone \r and \n. Splitting here, and not on \n alone, keeps the
 * numbers in the gutter equal to the line numbers in the check's findings; a lone \r would otherwise hide a line.
 */
export const splitScriptLines = (script: string): string[] => {
  const lines = script.split(/\r\n|\r|\n/);
  // A final line break ends the last line, it does not start a new one: "a\nb\n" is two lines, not three (no empty numbered row at the end).
  // Numbers of the lines that remain are untouched, so they still equal the line numbers in the check's findings.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Characters that make text on a screen differ from the text Python reads, or that cannot be seen at all. Shown as visible markers. */
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
export const hiddenLabel = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

export type Part = string | { mark: string; bidi: boolean };
/** A line cut into plain text and markers for each hidden character. */
export function lineParts(line: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of line.matchAll(HIDDEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    out.push({ mark: hiddenLabel(m[0]), bidi: BIDI.test(m[0]) });
    last = at + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
export const hiddenCount = (script: string): number => (script.match(HIDDEN) ?? []).length;

export function BlenderBadge({ mode }: { mode: CardMode }) {
  if (mode === 'live') return <span className="bl-badge live" title="Runs in your open Blender on this computer">Live</span>;
  if (mode === 'local') return <span className="bl-badge local" title="Runs in a background Blender on this computer, with your Windows user's rights">On this PC</span>;
  return <span className="bl-badge sandbox" title="Runs in a cloud VM, not on this computer">Cloud VM</span>;
}

/** The body of the approval card for blender_exec: the FULL script, wrapped (nothing hides off to the side), plus what the user needs to judge it. */
export function BlenderBody({ a }: { a: ApprovalRequest }) {
  const v = blenderView(a);
  const lines = splitScriptLines(v.script);
  const hidden = hiddenCount(v.script);
  return (
    <>
      <div className="bl-facts">
        <span>Where <b>{v.where || (v.mode === 'live' ? 'LIVE Blender on your computer' : v.mode === 'local' ? 'Blender in the background on this computer' : 'cloud VM')}</b></span>
        {v.agentName && <span>From <b>{v.agentName}</b></span>}
        <span><b>{lines.length}</b> lines</span>
        {v.backup && <span>Backup <b>{v.backup}</b></span>}
        {v.mode === 'local' && !v.backup && <span>Backup <b>scene copy before this run</b></span>}
        {v.hash && <span>sha256 <b>{v.hash}</b></span>}
      </div>
      {v.purpose && <p className="bl-purpose"><span className="bl-purpose-tag">The bot{'’'}s text, not checked:</span> {v.purpose}</p>}
      {v.live && <div className="bl-live-warn"><b>Live.</b> This runs in your open Blender with your files around it. The safety check is a filter, not a sandbox: read every line before you allow it.{v.exportDir ? ` Exports go to ${v.exportDir}.` : ''}</div>}
      {v.mode === 'local' && <div className="bl-live-warn"><b>On this PC.</b> {LOCAL_CARD_WARN}{localCardExports(v.exportDir)}</div>}
      {hidden > 0 && <div className="bl-live-warn" role="alert"><b>Hidden characters.</b> This script holds {hidden} character{hidden === 1 ? '' : 's'} you cannot normally see (zero-width, direction or line-separator marks). They are shown below as <span className="bl-hid">{'‹'}U+XXXX{'›'}</span> markers. Read the script as marked.</div>}
      <div className="bl-script" role="region" aria-label="Script to run" tabIndex={0}>
        {lines.map((line, n) => (
          <div className="bl-row" key={n}>
            <span className="bl-ln" aria-hidden="true">{n + 1}</span>
            <code className="bl-code">{lineParts(line).map((p, k) => (typeof p === 'string' ? p : <span key={k} className={`bl-hid${p.bidi ? ' bidi' : ''}`} title={p.bidi ? 'bidirectional control character' : 'invisible character'}>{'‹'}{p.mark}{'›'}</span>))}{'\n'}</code>
          </div>
        ))}
      </div>
      {v.notes.length > 0 && <ul className="bl-notes" aria-label="Notes from the safety check">{v.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </>
  );
}
