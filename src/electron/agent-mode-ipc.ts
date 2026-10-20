/**
 * Native confirmation for raising how little an agent asks (Accept edits, Full, or following a project whose preset is looser). The agent
 * editor names the change; this code asks the core what the agent would run as (`POST /api/agents/mode-preview`, the only place that decides
 * what raises it), shows a native dialog that lists the lines the core returned, and only after "Confirm" saves the change with the native
 * secret and the digest of what was shown. A change that keeps or tightens the mode needs no dialog and no secret. The window never has the
 * secret. Kept free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';
import { DENY_LINE, GATES_DIGEST_HEADER, NO_SANDBOX_LINE, PRESETS } from '../shared/gates-registry.js';
import type { Preset } from '../shared/gates-registry.js';

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

/** One sentence of a preview: the text as shown, and the part after the agent's own name (cut from the core's raw name, so a long name still matches). */
interface Line { text: string; body?: string }
interface Preview { raises: boolean; digest: string; loosening: string[]; lines: Line[]; agentName: string }
function parsePreview(j: unknown): Preview | undefined {
  if (!isObj(j) || typeof j.raises !== 'boolean' || typeof j.digest !== 'string' || !/^[0-9a-f]{64}$/.test(j.digest)) return undefined;
  if (!Array.isArray(j.loosening) || j.loosening.some((l) => typeof l !== 'string')) return undefined;
  const raw = typeof j.agentName === 'string' ? j.agentName : '';
  const lines: Line[] = (j.loosening as string[]).map((l) => ({ text: dialogLine(l, 400), ...(raw && l.startsWith(`${raw} `) ? { body: dialogLine(l.slice(raw.length + 1), 400) } : {}) })).filter((l) => l.text);
  return { raises: j.raises, digest: j.digest, agentName: dialogLine(raw, 60) || 'this agent', loosening: lines.map((l) => l.text), lines };
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
    who: `Agents › ${pv.agentName}`, items: pv.loosening, windowDetail: '',
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
  /** Only when the request carried the app default: whether it was saved. A cancel, or a default that could not be saved, leaves this false and changes nothing. */
  presetSaved?: boolean;
  /** The agents whose change was saved. */
  applied: string[];
  /** The agents whose change was not saved, and why. A cancel or a refusal before the dialog leaves both empty. */
  failed?: Array<{ agentId: string; error: string }>;
}
const MAX_BATCH = 100;
const NL = '\n';

/** What the window asked for: a list of agent mode changes and, for the first-run screen, the app default to save with them. */
export interface AgentModeBatchRequest { changes: AgentModeChange[]; preset?: Preset }

/** Strict parse: `{ changes: [...], preset? }`, one to 100 plain mode changes, each agent once, an optional app default, nothing else. */
export function parseAgentModeBatch(raw: unknown): AgentModeChange[] | undefined {
  return parseRequest(raw)?.changes;
}
function parseRequest(raw: unknown): AgentModeBatchRequest | undefined {
  if (!isObj(raw) || !Array.isArray(raw.changes)) return undefined;
  if (Object.keys(raw).some((k) => k !== 'changes' && k !== 'preset')) return undefined;
  if (raw.preset !== undefined && !(typeof raw.preset === 'string' && (PRESETS as readonly string[]).includes(raw.preset))) return undefined;
  if (raw.changes.length < 1 || raw.changes.length > MAX_BATCH) return undefined;
  const out: AgentModeChange[] = [];
  const seen = new Set<string>();
  for (const c of raw.changes) {
    const ch = parseAgentModeChange(c);
    if (!ch || seen.has(ch.agentId)) return undefined;
    seen.add(ch.agentId);
    out.push(ch);
  }
  return { changes: out, ...(raw.preset !== undefined ? { preset: raw.preset as Preset } : {}) };
}

/**
 * One native confirm for a whole list of mode changes, and for the app default that goes with them on the first-run screen. The core describes every
 * change first (`mode-preview`, and for the default `gates/preview`; an agent is previewed AS IF the default were already saved, read-only); if any of
 * them loosens, ONE dialog lists the default's lines and every agent made looser (agents with the same sentence share a line), then the agents that
 * get stricter. Cancel sends nothing at all. On Confirm the default is saved first (an ordinary guarded save with its own digest), then every agent is
 * previewed again against the saved default and must read exactly as shown (else no agent is changed and the answer says the default is saved), then
 * each change goes out as an ordinary guarded PATCH with its own digest (the native secret only on a raise). There is no bulk route in the core.
 */
export async function agentModeBatch(raw: unknown, deps: AgentModeIpcDeps): Promise<AgentModeBatchResult> {
  const req = parseRequest(raw);
  if (!req) return { ok: false, error: 'That request was not understood.', applied: [] };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.', applied: [] };
  open = true;
  try { return await runBatch(req, deps); } finally { open = false; }
}

interface Planned { ch: AgentModeChange; pv: Preview }

/** "Scout" alone, or "Scout (scout-2)" when another agent in the batch has the same display name. */
function labels(planned: Planned[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const p of planned) count.set(p.pv.agentName, (count.get(p.pv.agentName) ?? 0) + 1);
  return new Map(planned.map((p) => [p.ch.agentId, (count.get(p.pv.agentName) ?? 0) > 1 ? `${p.pv.agentName} (${p.ch.agentId})` : p.pv.agentName]));
}
const list = (n: string[]): string => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

/** The lines of every raise, one line per sentence: "A, B and C will ask only before ...". The closing safety lines are left to the caller.
 *  With the app default in the same dialog its own lines already say what it does, so an agent that follows it outside a project only says so. */
function batchLines(raising: Planned[], label: Map<string, string>, withDefault: boolean): string[] {
  const groups = new Map<string, string[]>();
  for (const { ch, pv } of raising) {
    for (const l of pv.lines) {
      if (l.text === DENY_LINE || l.text === NO_SANDBOX_LINE) continue;
      const key = withDefault && (l.body ?? '').startsWith(FOLLOW_APP) ? 'will follow the app default.' : l.body ?? l.text;
      const names = groups.get(key) ?? [];
      const nm = label.get(ch.agentId) ?? pv.agentName;
      if (!names.includes(nm)) names.push(nm);
      groups.set(key, names);
    }
  }
  return [...groups.entries()].map(([rest, names]) => `${list(names)} ${rest}`);
}

const FOLLOW_APP = 'will follow the way agents ask outside a project.';
const sameAs =(a: Preview, b: Preview): boolean => a.raises === b.raises && a.lines.length === b.lines.length && a.lines.every((l, i) => l.text === b.lines[i]!.text);
const gatesDigest = (digest: string): Record<string, string> => ({ [GATES_DIGEST_HEADER]: digest });
const STALE = 'The settings or an agent changed while the question was open, so nothing was changed.';

async function runBatch(req: AgentModeBatchRequest, deps: AgentModeIpcDeps): Promise<AgentModeBatchResult> {
  const { changes, preset } = req;
  // the app default (first-run screen): what it would do, as the core words it
  let presetPv: { loosens: boolean; digest: string; lines: string[] } | undefined;
  const patch = preset !== undefined ? { preset, firstRunChoice: true } : undefined;
  if (patch) {
    const cur = await deps.call('GET', '/api/gates/settings');
    if (!cur || cur.status !== 200) return { ...noCore, applied: [] };
    if (cur.json?.canSign === false && preset !== 'ask') return { ok: false, error: 'Your computer has no safe keystore, so only Ask can be used.', applied: [] };
    const pr = await deps.call('POST', '/api/gates/preview', { name: 'app', patch });
    if (!pr) return { ...noCore, applied: [] };
    if (pr.status !== 200) return { ...refused(pr), applied: [] };
    const j = pr.json;
    if (!isObj(j) || typeof j.loosens !== 'boolean' || typeof j.digest !== 'string' || !/^[0-9a-f]{64}$/.test(j.digest) || !Array.isArray(j.loosening) || j.loosening.some((l) => typeof l !== 'string')) return { ...cannotDescribe, applied: [] };
    presetPv = { loosens: j.loosens, digest: j.digest, lines: (j.loosening as string[]).map((l) => dialogLine(l, 400)).filter(Boolean) };
    if (presetPv.loosens && presetPv.lines.length === 0) return { ...cannotDescribe, applied: [] };
  }

  const planned: Planned[] = [];
  for (const ch of changes) {
    const pr = await deps.call('POST', '/api/agents/mode-preview', preset !== undefined ? { ...ch, assumeAppPreset: preset } : ch);
    if (!pr) return { ...noCore, applied: [] };
    if (pr.status !== 200) return { ...refused(pr), applied: [] };
    const pv = parsePreview(pr.json);
    if (!pv) return { ...cannotDescribe, applied: [] };
    if (pv.raises && pv.loosening.length === 0) return { ...cannotDescribe, applied: [] };
    planned.push({ ch, pv });
  }
  const label = labels(planned);
  const raising = planned.filter((p) => p.pv.raises);
  if (raising.length > 0 || presetPv?.loosens) {
    const clock = deps.now ?? Date.now;
    const key = `batch|${presetPv?.digest ?? ''}|${planned.map((p) => p.pv.digest).join('|')}`;
    if (lastCancel && lastCancel.key === key && clock() - lastCancel.at < CANCEL_PAUSE_MS) return { ok: false, error: 'You cancelled this change a moment ago. Wait a few seconds before you try it again.', applied: [] };
    // the default's own lines first (its closing safety lines are the same ones the agents' lines end with, so they come once, last)
    const lines = [...(presetPv?.lines ?? []).filter((l) => l !== DENY_LINE && l !== NO_SANDBOX_LINE), ...batchLines(raising, label, presetPv !== undefined)];
    const stricter = planned.filter((p) => !p.pv.raises).map((p) => label.get(p.ch.agentId) ?? p.pv.agentName);
    if (stricter.length > 0) lines.push(`${list(stricter)} will ask the same or more often.`);
    const closing = [DENY_LINE, NO_SANDBOX_LINE].filter((c) => (presetPv?.lines ?? []).includes(c) || raising.some((p) => p.pv.loosening.includes(c)));
    const n = raising.length;
    const ok = await deps.confirm({
      title: preset !== undefined ? 'Let agents ask less?' : 'Let these agents ask less?',
      message: preset !== undefined ? (n === 0 ? 'Change the default for how agents ask?' : `Change the default and how ${n === 1 ? label.get(raising[0]!.ch.agentId) : `${n} agents`} ask?`) : (n === 1 ? `Change how ${label.get(raising[0]!.ch.agentId)} asks?` : `Change how ${n} agents ask?`),
      detail: [...lines, ...closing].join(NL + NL),
      confirmLabel: 'Confirm change',
      who: preset !== undefined ? 'Agents › first-run setup' : 'Agents', items: [...lines, ...closing], windowDetail: '',
    });
    if (!ok) { lastCancel = { key, at: clock() }; return { ok: false, cancelled: true, presetSaved: false, applied: [] }; }
  }

  // the default first: an ordinary guarded save with its own digest (the native secret when it loosens)
  let presetSaved = false;
  if (patch && presetPv) {
    const res = await deps.call('PATCH', '/api/gates/app', patch, presetPv.loosens, gatesDigest(presetPv.digest));
    if (!res) return { ...noCore, presetSaved: false, applied: [] };
    if (res.status !== 200) return { ok: false, presetSaved: false, applied: [], error: res.status === 409 || (res.status === 403 && /native_/.test(String(res.json?.error ?? ''))) ? STALE : refused(res).error ?? 'The change was not made.' };
    presetSaved = true;
  }

  // with the default saved, every agent must read exactly as it was shown; else no agent is changed
  let digests = planned.map((p) => p.pv.digest);
  if (patch) {
    digests = [];
    for (const p of planned) {
      const pr = await deps.call('POST', '/api/agents/mode-preview', p.ch);
      const again = pr && pr.status === 200 ? parsePreview(pr.json) : undefined;
      if (!again || !sameAs(again, p.pv)) return { ok: false, presetSaved, applied: [], error: `${again ? 'an agent changed while the question was open' : 'Legion could not check an agent again'}. Set each agent in its editor.` };
      digests.push(again.digest);
    }
  }

  const applied: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  for (const [i, { ch, pv }] of planned.entries()) {
    const { agentId, ...body } = ch;
    const res = await deps.call('PATCH', `/api/agents/${encodeURIComponent(agentId)}`, body, pv.raises, gatesDigest(digests[i]!));
    if (!res) { failed.push({ agentId, error: noCore.error }); continue; }
    if (res.status === 200) { applied.push(agentId); continue; }
    failed.push({ agentId, error: res.status === 409 ? 'The agent changed while the question was open, so it was left as it was.' : refused(res).error ?? 'The change was not made.' });
  }
  const done = { ...(patch ? { presetSaved } : {}), applied };
  return failed.length === 0 ? { ok: true, ...done } : { ok: false, ...done, failed, error: `${failed.length} of ${planned.length} agents were not changed.` };
}
