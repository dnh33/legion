/**
 * Native confirmation for raising how little an agent asks (Accept edits, Full, or following a project whose preset is looser). The agent
 * editor names the change; this code asks the core what the agent would run as (`POST /api/agents/mode-preview`, the only place that decides
 * what raises it), shows a native dialog that lists the lines the core returned, and only after "Confirm" saves the change with the native
 * secret and the digest of what was shown. A change that keeps or tightens the mode needs no dialog and no secret. The window never has the
 * secret. Kept free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';
import { DENY_LINE, GATES_DIGEST_HEADER, NO_SANDBOX_LINE } from '../shared/gates-registry.js';

export interface AgentModeChange { agentId: string; approval?: 'ask' | 'auto-edits' | 'full'; approvalSource?: 'own' | 'project' }
export interface AgentModeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }
export interface AgentModeIpcDeps {
  /** A request to our own core with the admin secret, the native secret when `native` is true, and `extraHeaders` (the digest). undefined = no proven core. */
  call(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown, native?: boolean, extraHeaders?: Record<string, string>): Promise<CoreReply | undefined>;
  /** A native dialog (Cancel is the default button). Resolves true only for the confirm button. */
  confirm: ProviderIpcDeps['confirm'];
  now?(): number;
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent; anything else is refused. */
export function parseAgentModeChange(raw: unknown): AgentModeChange | undefined {
  if (!isObj(raw)) return undefined;
  const out: AgentModeChange = { agentId: '' };
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'agentId') { if (typeof v !== 'string' || !AGENT_ID_RE.test(v)) return undefined; out.agentId = v; }
    else if (k === 'approval') { if (v !== 'ask' && v !== 'auto-edits' && v !== 'full') return undefined; out.approval = v; }
    else if (k === 'approvalSource') { if (v !== 'own' && v !== 'project') return undefined; out.approvalSource = v; }
    else return undefined;
  }
  if (!out.agentId || (out.approval === undefined && out.approvalSource === undefined)) return undefined;
  return out;
}

interface Preview { raises: boolean; digest: string; loosening: string[]; agentName: string }
function parsePreview(j: unknown): Preview | undefined {
  if (!isObj(j) || typeof j.raises !== 'boolean' || typeof j.digest !== 'string' || !/^[0-9a-f]{64}$/.test(j.digest)) return undefined;
  if (!Array.isArray(j.loosening) || j.loosening.some((l) => typeof l !== 'string')) return undefined;
  return { raises: j.raises, digest: j.digest, agentName: dialogLine(j.agentName, 60) || 'this agent', loosening: (j.loosening as string[]).map((l) => dialogLine(l, 400)).filter(Boolean) };
}

let open = false;
/** The change the owner just cancelled, so the same change cannot raise another dialog at once. */
let lastCancel: { key: string; at: number } | undefined;
const CANCEL_PAUSE_MS = 3000;
export function resetAgentModeCancelForTests(): void { lastCancel = undefined; open = false; }

export async function agentModeChange(raw: unknown, deps: AgentModeIpcDeps): Promise<AgentModeResult> {
  const ch = parseAgentModeChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { return await run(ch, deps); } finally { open = false; }
}

const noCore = { ok: false, error: 'Legion could not reach its own core. Restart Legion.' } as const;
const cannotDescribe = { ok: false, error: 'Legion could not describe this change, so it was not made.' } as const;
const refused = (res: CoreReply): AgentModeResult => ({ ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` });

async function run(ch: AgentModeChange, deps: AgentModeIpcDeps): Promise<AgentModeResult> {
  const { agentId, ...patch } = ch;
  const pr = await deps.call('POST', '/api/agents/mode-preview', ch);
  if (!pr) return noCore;
  if (pr.status !== 200) return refused(pr);
  const pv = parsePreview(pr.json);
  if (!pv) return cannotDescribe;
  const route = `/api/agents/${encodeURIComponent(agentId)}`;
  const digest = { [GATES_DIGEST_HEADER]: pv.digest };

  if (!pv.raises) {
    const res = await deps.call('PATCH', route, patch, false, digest);
    if (!res) return noCore;
    if (res.status === 409) return { ok: false, error: 'The agent changed while this was being checked. Try again.' };
    return res.status === 200 ? { ok: true, view: res.json } : refused(res);
  }

  if (pv.loosening.length === 0) return cannotDescribe;
  const clock = deps.now ?? Date.now;
  const key = `${agentId}\n${pv.digest}`;
  if (lastCancel && lastCancel.key === key && clock() - lastCancel.at < CANCEL_PAUSE_MS) return { ok: false, error: 'You cancelled this change a moment ago. Wait a few seconds before you try it again.' };
  const ok = await deps.confirm({
    title: 'Let this agent ask less?',
    message: `Change how ${pv.agentName} asks?`,
    detail: pv.loosening.join('\n\n'),
    confirmLabel: 'Confirm change',
  });
  if (!ok) { lastCancel = { key, at: clock() }; return { ok: false, cancelled: true }; }

  const res = await deps.call('PATCH', route, patch, true, digest);
  if (!res) return noCore;
  if (res.status === 409) return { ok: false, error: 'The agent changed while the question was open. Nothing was changed; try again.' };
  return res.status === 200 ? { ok: true, view: res.json } : refused(res);
}

// ---------------------------------------------------------------- many agents at once (the first-run "Also make my agents follow this")

export interface AgentModeBatchResult {
  ok: boolean; error?: string; cancelled?: boolean;
  /** The agents whose change was saved. */
  applied: string[];
  /** The agents whose change was not saved, and why. A cancel or a refusal before the dialog leaves both empty. */
  failed?: Array<{ agentId: string; error: string }>;
}
const MAX_BATCH = 100;
const NL = String.fromCharCode(10);

/** Strict parse: `{ changes: [...] }`, one to 100 plain mode changes, each agent once, nothing else. */
export function parseAgentModeBatch(raw: unknown): AgentModeChange[] | undefined {
  if (!isObj(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.changes)) return undefined;
  if (raw.changes.length < 1 || raw.changes.length > MAX_BATCH) return undefined;
  const out: AgentModeChange[] = [];
  const seen = new Set<string>();
  for (const c of raw.changes) {
    const ch = parseAgentModeChange(c);
    if (!ch || seen.has(ch.agentId)) return undefined;
    seen.add(ch.agentId);
    out.push(ch);
  }
  return out;
}

/**
 * One native confirm for a whole list of mode changes. The core describes every change first (`mode-preview`); if any of them raises, ONE dialog
 * names every agent made looser (agents with the same sentence share a line), and only after "Confirm" does each change go out as an ordinary
 * guarded PATCH with its own digest (the native secret only on a raise). There is no bulk route in the core: a change that went stale while the
 * dialog was open is refused by its own digest and reported, and the others still apply. A cancel, or a change the core cannot describe,
 * sends no PATCH at all.
 */
export async function agentModeBatch(raw: unknown, deps: AgentModeIpcDeps): Promise<AgentModeBatchResult> {
  const changes = parseAgentModeBatch(raw);
  if (!changes) return { ok: false, error: 'That request was not understood.', applied: [] };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.', applied: [] };
  open = true;
  try { return await runBatch(changes, deps); } finally { open = false; }
}

interface Planned { ch: AgentModeChange; pv: Preview }

/** The lines of every raise, one line per sentence: "A, B and C will ask only before ...". The closing safety lines come once at the end. */
function batchLines(raising: Planned[]): string[] {
  const groups = new Map<string, string[]>();
  let closing = false;
  for (const { pv } of raising) {
    for (const l of pv.loosening) {
      if (l === DENY_LINE || l === NO_SANDBOX_LINE) { closing = true; continue; }
      const cut = l.startsWith(`${pv.agentName} `) ? l.slice(pv.agentName.length + 1) : l;
      const names = groups.get(cut) ?? [];
      if (!names.includes(pv.agentName)) names.push(pv.agentName);
      groups.set(cut, names);
    }
  }
  const list = (n: string[]): string => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
  const lines = [...groups.entries()].map(([rest, names]) => `${list(names)} ${rest}`);
  return closing ? [...lines, DENY_LINE, NO_SANDBOX_LINE] : lines;
}

async function runBatch(changes: AgentModeChange[], deps: AgentModeIpcDeps): Promise<AgentModeBatchResult> {
  const planned: Planned[] = [];
  for (const ch of changes) {
    const pr = await deps.call('POST', '/api/agents/mode-preview', ch);
    if (!pr) return { ...noCore, applied: [] };
    if (pr.status !== 200) return { ...refused(pr), applied: [] };
    const pv = parsePreview(pr.json);
    if (!pv) return { ...cannotDescribe, applied: [] };
    if (pv.raises && pv.loosening.length === 0) return { ...cannotDescribe, applied: [] };
    planned.push({ ch, pv });
  }
  const raising = planned.filter((p) => p.pv.raises);
  if (raising.length > 0) {
    const clock = deps.now ?? Date.now;
    const key = `batch|${planned.map((p) => p.pv.digest).join('|')}`;
    if (lastCancel && lastCancel.key === key && clock() - lastCancel.at < CANCEL_PAUSE_MS) return { ok: false, error: 'You cancelled this change a moment ago. Wait a few seconds before you try it again.', applied: [] };
    const n = raising.length;
    const ok = await deps.confirm({
      title: 'Let these agents ask less?',
      message: n === 1 ? `Change how ${raising[0]!.pv.agentName} asks?` : `Change how ${n} agents ask?`,
      detail: batchLines(raising).join(NL + NL),
      confirmLabel: 'Confirm change',
    });
    if (!ok) { lastCancel = { key, at: clock() }; return { ok: false, cancelled: true, applied: [] }; }
  }
  const applied: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  for (const { ch, pv } of planned) {
    const { agentId, ...patch } = ch;
    const res = await deps.call('PATCH', `/api/agents/${encodeURIComponent(agentId)}`, patch, pv.raises, { [GATES_DIGEST_HEADER]: pv.digest });
    if (!res) { failed.push({ agentId, error: noCore.error }); continue; }
    if (res.status === 200) { applied.push(agentId); continue; }
    failed.push({ agentId, error: res.status === 409 ? 'The agent changed while the question was open, so it was left as it was.' : refused(res).error ?? 'The change was not made.' });
  }
  return failed.length === 0 ? { ok: true, applied } : { ok: false, applied, failed, error: `${failed.length} of ${planned.length} agents were not changed.` };
}
