/**
 * Native confirmation for raising how little an agent asks (Accept edits, Full, or following a project whose preset is looser). The agent
 * editor names the change; this code asks the core what the agent would run as (`POST /api/agents/mode-preview`, the only place that decides
 * what raises it), shows a native dialog that lists the lines the core returned, and only after "Confirm" saves the change with the native
 * secret and the digest of what was shown. A change that keeps or tightens the mode needs no dialog and no secret. The window never has the
 * secret. Kept free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';
import { GATES_DIGEST_HEADER } from '../shared/gates-registry.js';

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
