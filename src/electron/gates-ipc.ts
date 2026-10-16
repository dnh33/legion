/**
 * Native confirmation for gate changes that loosen anything (a looser preset, a project's limit off, a gate switched off, an approved
 * site or kept variable, applying a settings file that changed outside Legion). The window names a change; this code asks the core
 * what that change would do (`POST /api/gates/preview`, the only place that decides what a loosening is), shows a native dialog that
 * lists exactly the lines the core returned, and only after "Confirm" sends the change with the native secret and the digest of what
 * was shown. The core refuses the change if what it would apply now differs from that digest. The window never has the secret.
 * A tightening needs no dialog and no native secret. Kept free of electron imports so it can be tested with fakes.
 */
import { GATES_DIGEST_HEADER, PERMISSION_GATE_IDS, PRESETS } from '../shared/gates-registry.js';
import type { GateValue, Preset } from '../shared/gates-registry.js';
import { dialogLine } from './provider-ipc.js';
import type { CoreReply } from './provider-ipc.js';

export interface GatePatch { preset?: Preset | null; limit?: boolean; overrides?: Record<string, GateValue>; allowedHosts?: string[]; envKeep?: string[] }
export type GatesChange =
  | { kind: 'app'; patch: GatePatch }
  | { kind: 'project'; id: string; patch: GatePatch }
  | { kind: 'accept'; name: string }
  | { kind: 'keep'; name: string };
export interface GatesChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }
export interface GatesIpcDeps {
  /** A request to our own core with the admin secret, the native secret when `native` is true, and `extraHeaders` (the digest). undefined = no proven core. */
  call(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown, native?: boolean, extraHeaders?: Record<string, string>): Promise<CoreReply | undefined>;
  /** A native dialog (Cancel is the default button). Resolves true only for the confirm button. */
  confirm(opts: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
}

const PROJECT_ID_RE = /^proj_[a-f0-9]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent; anything else (an unknown key, a gate that is not a permission gate, a number out of range) is refused. */
export function parseGatesChange(raw: unknown): GatesChange | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.kind === 'accept' || raw.kind === 'keep') {
    if (typeof raw.name !== 'string' || !(raw.name === 'app' || PROJECT_ID_RE.test(raw.name))) return undefined;
    return raw.kind === 'accept' ? { kind: 'accept', name: raw.name } : { kind: 'keep', name: raw.name };
  }
  if (raw.kind !== 'app' && raw.kind !== 'project') return undefined;
  const patch = parsePatch(raw.patch, raw.kind === 'app');
  if (!patch) return undefined;
  if (raw.kind === 'app') return { kind: 'app', patch };
  return typeof raw.id === 'string' && PROJECT_ID_RE.test(raw.id) ? { kind: 'project', id: raw.id, patch } : undefined;
}

function parsePatch(v: unknown, isApp: boolean): GatePatch | undefined {
  if (!isObj(v)) return undefined;
  const out: GatePatch = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'preset') {
      if (x !== null && !(typeof x === 'string' && (PRESETS as readonly string[]).includes(x))) return undefined;
      out.preset = x as Preset | null;
    } else if (k === 'allowedHosts' && isApp) {
      // the core checks the names themselves; here only the shape and the size
      if (!Array.isArray(x) || x.length > 200 || x.some((h) => typeof h !== 'string' || h.length > 253)) return undefined;
      out.allowedHosts = x as string[];
    } else if (k === 'envKeep' && isApp) {
      if (!Array.isArray(x) || x.length > 50 || x.some((n) => typeof n !== 'string' || n.length > 100)) return undefined;
      out.envKeep = x as string[];
    } else if (k === 'limit' && !isApp) {
      if (typeof x !== 'boolean') return undefined;
      out.limit = x;
    } else if (k === 'overrides' && !isApp) {
      if (!isObj(x)) return undefined;
      const ov: Record<string, GateValue> = {};
      for (const [id, val] of Object.entries(x)) {
        if (!PERMISSION_GATE_IDS.includes(id)) return undefined;
        if (typeof val === 'boolean') ov[id] = val;
        else if (isObj(val) && val.on === true && typeof val.limit === 'number' && Number.isInteger(val.limit) && val.limit >= 1 && val.limit <= 100 && Object.keys(val).length === 2) ov[id] = { on: true, limit: val.limit };
        else return undefined;
      }
      out.overrides = ov;
    } else return undefined; // includes any shell-floor key: the floor has no switch
  }
  return Object.keys(out).length ? out : undefined;
}

interface GateView { changedOutside?: string[]; canSign?: boolean; keyUnreadable?: boolean }
interface Preview { loosening: string[]; loosens: boolean; digest: string }

let open = false;

export async function gatesChange(raw: unknown, deps: GatesIpcDeps): Promise<GatesChangeResult> {
  const ch = parseGatesChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { return await run(ch, deps); } finally { open = false; }
}

const noCore = { ok: false, error: 'Legion could not reach its own core. Restart Legion.' } as const;
const cannotDescribe = { ok: false, error: 'Legion could not describe this change, so it was not made.' } as const;
const refused = (res: CoreReply): GatesChangeResult => ({ ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` });
const noKey = (view: GateView): GatesChangeResult => ({ ok: false, error: view.keyUnreadable ? 'Legion could not open its settings key, so only Ask can be used until that is fixed.' : 'Your computer has no safe keystore, so only Ask can be used.' });

/** The core's answer, checked: a digest and plain lines, nothing else is trusted. */
function parsePreview(j: unknown): Preview | undefined {
  if (!isObj(j) || typeof j.loosens !== 'boolean' || typeof j.digest !== 'string' || !/^[0-9a-f]{64}$/.test(j.digest)) return undefined;
  if (!Array.isArray(j.loosening) || j.loosening.some((l) => typeof l !== 'string')) return undefined;
  return { loosens: j.loosens, digest: j.digest, loosening: (j.loosening as string[]).map((l) => dialogLine(l, 400)).filter(Boolean) };
}

async function run(ch: GatesChange, deps: GatesIpcDeps): Promise<GatesChangeResult> {
  const cur = await deps.call('GET', '/api/gates/settings');
  if (!cur || cur.status !== 200) return noCore;
  const view = (cur.json ?? {}) as GateView;

  if (ch.kind === 'keep') {
    const res = await deps.call('POST', `/api/gates/keep/${ch.name}`);
    if (!res) return noCore;
    return res.status === 200 ? { ok: true, view: res.json } : refused(res);
  }

  const name = ch.kind === 'app' ? 'app' : ch.kind === 'project' ? ch.id : ch.name;
  const scope = name === 'app' ? 'all projects' : `the project "${await projectName(deps, name)}"`;
  if (ch.kind === 'accept' && !(view.changedOutside ?? []).includes(ch.name)) return { ok: false, error: 'That settings file has not changed outside Legion.' };
  const route = ch.kind === 'app' ? '/api/gates/app' : ch.kind === 'project' ? `/api/gates/projects/${ch.id}` : `/api/gates/accept/${ch.name}`;
  const method = ch.kind === 'accept' ? 'POST' : 'PATCH';
  const body = ch.kind === 'accept' ? undefined : ch.patch;

  // The core says what this change does. Nothing below guesses.
  const pr = await deps.call('POST', '/api/gates/preview', ch.kind === 'accept' ? { name, accept: true } : { name, patch: ch.patch });
  if (!pr) return noCore;
  if (pr.status !== 200) return refused(pr);
  const pv = parsePreview(pr.json);
  if (!pv) return cannotDescribe;
  const digest = { [GATES_DIGEST_HEADER]: pv.digest };

  if (!pv.loosens) {
    const res = await deps.call(method, route, body, false, digest);
    if (!res) return noCore;
    if (res.status === 403 && /native_/.test(String(res.json?.error ?? ''))) return { ok: false, error: 'The settings changed while this was being checked. Try again.' };
    return res.status === 200 ? { ok: true, view: res.json } : refused(res);
  }

  // Only Ask can be stored without a key to sign with, so a loosening is refused before any dialog.
  if (view.canSign === false) return noKey(view);
  if (pv.loosening.length === 0 && ch.kind !== 'accept') return cannotDescribe;
  const detail = pv.loosening.length ? pv.loosening.join('\n\n') : 'The file sets nothing looser than Legion holds now.';
  const ok = await deps.confirm(ch.kind === 'accept'
    ? { title: 'Use the settings found in the file?', message: `Another program changed the settings file for ${scope}. Use it?`, detail, confirmLabel: 'Use these settings' }
    : { title: 'Let agents ask less?', message: `Change the settings for ${scope}?`, detail, confirmLabel: 'Confirm change' });
  if (!ok) return { ok: false, cancelled: true };

  const res = await deps.call(method, route, body, true, digest);
  if (!res) return noCore;
  return res.status === 200 ? { ok: true, view: res.json } : refused(res);
}

async function projectName(deps: GatesIpcDeps, id: string): Promise<string> {
  try {
    const r = await deps.call('GET', `/api/projects/${id}`);
    const n = r && r.status === 200 ? dialogLine(r.json?.name, 60) : '';
    return n || 'this project';
  } catch { return 'this project'; }
}
