import { memo, useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { selectTask, useStore } from '../store';
import { todoChipLabel } from '../chat/todos';
import { clip, shortTool, toolPreview, tryPretty } from '../util';
import { Icon } from './icons';
import { bridgeAgentRef, bridgeOutcome, bridgeVerb, type BridgeOutcome } from '../chat/bridgeView';

export interface Bridge { verb: string; kind: 'ask' | 'tell' | 'agents'; target?: string; message?: string; outcome?: BridgeOutcome; list?: string[] }

/** Tools that are internal noise; their chips are not shown. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);
export const isHiddenTool = (name?: string) => !!name && [...HIDDEN_TOOLS].some((h) => name === h || name.endsWith('__' + h));
/** Reads mcp__legion__ask / tell / agents tool calls into something a person can follow. */
function bridgeInfo(m: ChatMessage, nameOf: (id: string) => string, rawResult: string | undefined, live: boolean): Bridge | null {
  const n = bridgeVerb(m.toolName);
  if (n !== 'ask' && n !== 'tell' && n !== 'agents') return null;
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(m.text) as Record<string, unknown>; } catch { /* keep empty */ }
  let parsed: unknown;
  try { parsed = rawResult ? JSON.parse(rawResult) : undefined; } catch { parsed = undefined; }
  if (n === 'agents') {
    let list: string[] | undefined;
    const arr = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { agents?: unknown })?.agents) ? (parsed as { agents: unknown[] }).agents : null;
    if (arr) list = arr.map((x) => (typeof x === 'string' ? x : (() => { const r = x as Record<string, unknown>; return [r.name ?? r.id, r.status, r.role].filter(Boolean).join(' \u00b7 '); })()));
    else if (rawResult) list = rawResult.split('\n').map((l) => l.trim()).filter(Boolean);
    return { verb: 'Checked who is available', kind: n, list };
  }
  const ref = typeof o.agent === 'string' ? o.agent : bridgeAgentRef(m.text);
  const target = ref ? nameOf(ref) : 'an agent';
  return { verb: n === 'ask' ? 'Asked' : 'Told', kind: n, target, message: typeof o.message === 'string' ? o.message : undefined, outcome: bridgeOutcome(n, rawResult, target, live) };
}

function ToolGroupImpl({ items, results = {} }: { items: ChatMessage[]; results?: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const agents = useStore((s) => s.agents);
  const nameOf = (id: string) => agents.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())?.name ?? id;
  const openMsg = items.find((m) => m.id === open);
  const resultOf = (m: ChatMessage) => (m.toolUseId ? results[m.toolUseId] : undefined);
  // whether the calling task is still going: a call with no result yet is then pending, not lost
  const live = useStore((s) => { const st = s.tasks.find((t) => t.id === items[0]?.taskId)?.status; return st === 'running' || st === 'queued'; });
  const openBridge = openMsg ? bridgeInfo(openMsg, nameOf, resultOf(openMsg), live) : null;
  if (items.every((m) => isHiddenTool(m.toolName))) return null;
  return (
    <div className="toolgroup">
      <div className="chips">
        {items.filter((m) => !isHiddenTool(m.toolName)).map((m) => {
          const br = bridgeInfo(m, nameOf, resultOf(m), live);
          // a refused or failed hand-off is visible on the closed chip too, not only after opening it (review of 0.2.5-f)
          const failed = br?.outcome?.tone === 'error';
          const notSent = failed && br?.outcome?.text.startsWith('Not sent');
          if (br) return (
            <button key={m.id} className={`chip bridge${failed ? ' failed' : ''}${open === m.id ? ' open' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} title={m.text}>
              <Icon name="arrow" size={12} />
              <b>{notSent ? 'Not sent to' : br.verb}{br.target ? ` ${br.target}` : ''}</b>
              {br.message && <span>{'\u201c'}{clip(br.message, 60)}{'\u201d'}</span>}
              <Icon name="chevron" size={11} />
            </button>
          );
          const todoLabel = m.toolName === 'TodoWrite' ? todoChipLabel(m.text) : null;
          return (
          <button key={m.id} className={`chip${open === m.id ? ' open' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} title={m.text}>
            <Icon name="tool" size={12} />
            {todoLabel ? <b>{todoLabel}</b> : <><b>{shortTool(m.toolName)}</b><span>{toolPreview(m.text)}</span></>}
            <Icon name="chevron" size={11} />
          </button>
          );
        })}
      </div>
      {openMsg && openBridge && <BridgeDetail b={openBridge} />}
      {openMsg && !openBridge && (
        <div className="chip-detail-wrap">
          <pre className="chip-detail">{tryPretty(openMsg.text)}</pre>
          {resultOf(openMsg) && <><h6 className="chip-result-h">Result</h6><pre className="chip-detail chip-result">{resultOf(openMsg)}</pre></>}
        </div>
      )}
    </div>
  );
}

/** The expanded panel of an ask / tell / agents chip. */
export function BridgeDetail({ b }: { b: Bridge }) {
  const o = b.outcome;
  return (
    <div className="chip-detail bridge-detail">
      {b.kind === 'agents' ? (
        b.list?.length ? <><h6>Agents</h6><ul className="bridge-list">{b.list.map((l, i) => <li key={i}>{l}</li>)}</ul></> : <p>Looked up the other agents and their status.</p>
      ) : (<>
        {b.message && <><h6>{b.verb} {b.target}</h6><p>{b.message}</p></>}
        {o && (o.heading
          ? <><h6>{o.heading}</h6><p className="bridge-result">{o.text}</p></>
          : <p className={o.tone === 'error' ? 'err-s' : 'muted-s'}>{o.text}{o.taskId && <> <button type="button" className="link-btn" onClick={() => selectTask(o.taskId!)}>Open their task</button></>}</p>)}
      </>)}
    </div>
  );
}

type TGProps = Parameters<typeof ToolGroupImpl>[0];
/** Thread rebuilds `items` and `results` on every message; a group re-renders only if one of its own calls or results changed. */
export const ToolGroup = memo(ToolGroupImpl, (p: TGProps, n: TGProps) => {
  if (p.items.length !== n.items.length) return false;
  for (let i = 0; i < p.items.length; i++) {
    const a = p.items[i]!; const b = n.items[i]!;
    if (a !== b && (a.id !== b.id || a.text !== b.text || a.toolName !== b.toolName || a.toolUseId !== b.toolUseId)) return false;
    if (a.toolUseId && p.results?.[a.toolUseId] !== n.results?.[a.toolUseId]) return false;
  }
  return true;
});
