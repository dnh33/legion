import { memo, useState } from 'react';
import type { ChatMessage } from '../../../src/shared/types';
import { selectTask, useStore } from '../store';
import { clip, shortTool, toolPreview, tryPretty } from '../util';
import { Icon } from './icons';

interface Bridge { verb: string; kind: 'ask' | 'tell' | 'agents'; target?: string; message?: string; result?: string; taskId?: string; list?: string[] }

/** Tools that are internal noise; their chips are not shown. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);
export const isHiddenTool = (name?: string) => !!name && [...HIDDEN_TOOLS].some((h) => name === h || name.endsWith('__' + h));
/** Reads mcp__legion__ask / tell / agents tool calls into something a person can follow. */
function bridgeResult(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try { const o = JSON.parse(raw) as Record<string, unknown>; if (typeof o.result === 'string') return o.result; } catch { /* plain or clipped JSON */ }
  // Older cores clipped the JSON mid-string; recover the readable result text.
  const m = /"result"\s*:\s*"([\s\S]*)$/.exec(raw);
  if (m) return m[1]!.replace(/"\s*}\s*$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return raw;
}

function bridgeInfo(m: ChatMessage, nameOf: (id: string) => string, rawResult?: string): Bridge | null {
  const n = (m.toolName ?? '').replace(/^mcp__legion__/, '');
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
  const target = typeof o.agent === 'string' ? nameOf(o.agent) : 'an agent';
  const taskId = typeof (parsed as { taskId?: unknown } | undefined)?.taskId === 'string' ? (parsed as { taskId: string }).taskId : undefined;
  const res = n === 'tell' ? undefined : bridgeResult(rawResult);
  return { verb: n === 'ask' ? 'Asked' : 'Told', kind: n, target, message: typeof o.message === 'string' ? o.message : undefined, result: res, taskId };
}

function ToolGroupImpl({ items, results = {} }: { items: ChatMessage[]; results?: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const agents = useStore((s) => s.agents);
  const nameOf = (id: string) => agents.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())?.name ?? id;
  const openMsg = items.find((m) => m.id === open);
  const resultOf = (m: ChatMessage) => (m.toolUseId ? results[m.toolUseId] : undefined);
  const openBridge = openMsg ? bridgeInfo(openMsg, nameOf, resultOf(openMsg)) : null;
  if (items.every((m) => isHiddenTool(m.toolName))) return null;
  return (
    <div className="toolgroup">
      <div className="chips">
        {items.filter((m) => !isHiddenTool(m.toolName)).map((m) => {
          const br = bridgeInfo(m, nameOf, resultOf(m));
          if (br) return (
            <button key={m.id} className={`chip bridge${open === m.id ? ' open' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} title={m.text}>
              <Icon name="arrow" size={12} />
              <b>{br.verb}{br.target ? ` ${br.target}` : ''}</b>
              {br.message && <span>{'\u201c'}{clip(br.message, 60)}{'\u201d'}</span>}
              <Icon name="chevron" size={11} />
            </button>
          );
          return (
          <button key={m.id} className={`chip${open === m.id ? ' open' : ''}`} onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} title={m.text}>
            <Icon name="tool" size={12} />
            <b>{shortTool(m.toolName)}</b>
            <span>{toolPreview(m.text)}</span>
            <Icon name="chevron" size={11} />
          </button>
          );
        })}
      </div>
      {openMsg && openBridge && (
        <div className="chip-detail bridge-detail">
          {openBridge.kind === 'agents' ? (
            openBridge.list?.length ? <><h6>Agents</h6><ul className="bridge-list">{openBridge.list.map((l, i) => <li key={i}>{l}</li>)}</ul></> : <p>Looked up the other agents and their status.</p>
          ) : (<>
            {openBridge.message && <><h6>{openBridge.verb} {openBridge.target}</h6><p>{openBridge.message}</p></>}
            {openBridge.kind === 'tell'
              ? <p className="muted-s">Sent. {openBridge.target}{'\u2019'}s reply will arrive in this task.{openBridge.taskId && <> <button type="button" className="link-btn" onClick={() => selectTask(openBridge.taskId!)}>Open their task</button></>}</p>
              : openBridge.result ? <><h6>Result</h6><p className="bridge-result">{openBridge.result}</p></> : <p className="muted-s">No result was recorded for this call.</p>}
          </>)}
        </div>
      )}
      {openMsg && !openBridge && (
        <div className="chip-detail-wrap">
          <pre className="chip-detail">{tryPretty(openMsg.text)}</pre>
          {resultOf(openMsg) && <><h6 className="chip-result-h">Result</h6><pre className="chip-detail chip-result">{resultOf(openMsg)}</pre></>}
        </div>
      )}
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
