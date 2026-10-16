/**
 * Native confirmation for gate changes that loosen anything (a looser preset, a project's limit off, a gate switched off, applying a
 * settings file that changed outside Legion). The window names a change; this code words a native dialog from facts it reads from the
 * core itself and the registry (never from the window), and only after "Confirm" calls the core with the native secret, which the
 * window never has. A tightening needs no dialog and no native secret. The core stays the authority on what is a loosening: if it
 * refuses a change this code took for a tightening, the same dialog is shown and the change is retried with the secret.
 * Kept free of electron imports so it can be tested with fakes.
 */
import { GATES, NO_SANDBOX_LINE, PERMISSION_GATE_IDS, PRESETS } from '../shared/gates-registry.js';
import type { GateValue, Preset } from '../shared/gates-registry.js';
import { dialogLine } from './provider-ipc.js';
import type { CoreReply } from './provider-ipc.js';

export interface GatePatch { preset?: Preset | null; limit?: boolean; overrides?: Record<string, GateValue> }
export type GatesChange =
  | { kind: 'app'; patch: GatePatch }
  | { kind: 'project'; id: string; patch: GatePatch }
  | { kind: 'accept'; name: string }
  | { kind: 'keep'; name: string };
export interface GatesChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }
export interface GatesIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
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

/** The Bypass text, exported so the tests and the Gates page share one copy. */
export function bypassDetail(): string {
  return `No permission cards. Agents run commands, change files and write to GitHub without asking. Your deny rules and Legion's safety rails still apply, and everything is logged. ${NO_SANDBOX_LINE}`;
}

const PRESET_DIALOG: Record<'accept-edits' | 'smart' | 'bypass', { title: string; name: string; detail: () => string }> = {
  'accept-edits': { title: 'Let file edits run?', name: 'Accept edits', detail: () => `File edits run without asking. Everything else still asks. Your deny rules and Legion's safety rails still apply. ${NO_SANDBOX_LINE}` },
  smart: { title: 'Let Legion decide when to ask?', name: 'Smart', detail: () => `Asks only before an action that sends data out, deletes, spends, can't be undone, or that Legion can't classify. Everything else runs. Your deny rules and safety rails still apply. Everything is logged. ${NO_SANDBOX_LINE}` },
  bypass: { title: 'Turn off permission cards?', name: 'Bypass', detail: bypassDetail },
};
const RANK: Record<Preset, number> = { ask: 0, 'accept-edits': 1, smart: 2, bypass: 3 };
/** The same order the core uses: Smart and Accept edits are not ordered, so a switch either way counts as a loosening. */
const looser = (to: Preset, from: Preset | undefined): boolean => {
  const f = from ?? 'ask';
  return to !== f && (RANK[to] > RANK[f] || (to === 'accept-edits' && f === 'smart') || (to === 'smart' && f === 'accept-edits'));
};

interface GateView { app?: { preset?: Preset }; projects?: Record<string, { preset?: Preset; limit?: boolean; overrides?: Record<string, GateValue> }>; changedOutside?: string[]; canSign?: boolean; keyUnreadable?: boolean }

interface Ask { title: string; message: string; detail: string; confirmLabel: string }

/** The dialog for a patch, or undefined when nothing in it looks like a loosening. */
function askForPatch(patch: GatePatch, scopeName: string, current: { preset?: Preset; limit?: boolean; overrides?: Record<string, GateValue> }): Ask | undefined {
  const parts: string[] = [];
  let title = ''; let message = '';
  if (typeof patch.preset === 'string' && patch.preset !== 'ask' && looser(patch.preset, current.preset)) {
    const d = PRESET_DIALOG[patch.preset];
    title = d.title; message = `Set "${scopeName}" to ${d.name}?`; parts.push(d.detail());
  }
  if (patch.limit === false && current.limit !== false) {
    if (!title) { title = 'Let agents go beyond this setting?'; message = `Turn off the limit for "${scopeName}"?`; }
    parts.push("Agents with their own mode can go beyond this project's setting.");
  }
  for (const [id, v] of Object.entries(patch.overrides ?? {})) {
    if (v !== false || current.overrides?.[id] === false) continue;
    const g = GATES.find((x) => x.id === id);
    if (!g) continue;
    if (!title) { title = 'Switch a safeguard off?'; message = `Change the safeguards for "${scopeName}"?`; }
    parts.push(`${g.label}: ${g.ifOff}`);
  }
  return title ? { title, message, detail: parts.join('\n\n'), confirmLabel: 'Confirm change' } : undefined;
}

const genericAsk = (scopeName: string): Ask => ({
  title: 'Change this setting?', message: `Change the permission settings for "${scopeName}"?`, confirmLabel: 'Confirm change',
  detail: `This lets agents work with fewer questions than before. Your deny rules and Legion's safety rails still apply. ${NO_SANDBOX_LINE}`,
});

let open = false;

export async function gatesChange(raw: unknown, deps: GatesIpcDeps): Promise<GatesChangeResult> {
  const ch = parseGatesChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { return await run(ch, deps); } finally { open = false; }
}

const noCore = { ok: false, error: 'Legion could not reach its own core. Restart Legion.' } as const;
const refused = (res: CoreReply): GatesChangeResult => ({ ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` });

async function run(ch: GatesChange, deps: GatesIpcDeps): Promise<GatesChangeResult> {
  const cur = await deps.call('GET', '/api/gates/settings');
  if (!cur || cur.status !== 200) return noCore;
  const view = (cur.json ?? {}) as GateView;

  if (ch.kind === 'keep') {
    const res = await deps.call('POST', `/api/gates/keep/${ch.name}`);
    if (!res) return noCore;
    return res.status === 200 ? { ok: true, view: res.json } : refused(res);
  }

  const isApp = ch.kind === 'app';
  const name = ch.kind === 'app' ? 'app' : ch.kind === 'project' ? ch.id : ch.name;
  const scopeName = name === 'app' ? 'All projects' : await projectName(deps, name);
  let route: string; let method: 'PATCH' | 'POST'; let body: unknown; let ask: Ask | undefined;

  if (ch.kind === 'accept') {
    if (!(view.changedOutside ?? []).includes(ch.name)) return { ok: false, error: 'That settings file has not changed outside Legion.' };
    route = `/api/gates/accept/${ch.name}`; method = 'POST'; body = undefined;
    ask = {
      title: 'Use the settings found in the file?', message: `Use the changed settings file for "${scopeName}"?`, confirmLabel: 'Use these settings',
      detail: `Another program changed this settings file. Using it can let agents ask less often. If you did not change it yourself, choose Cancel and keep the settings Legion holds. ${NO_SANDBOX_LINE}`,
    };
  } else {
    const patch = ch.patch;
    route = ch.kind === 'app' ? '/api/gates/app' : `/api/gates/projects/${ch.id}`; method = 'PATCH'; body = patch;
    const now = ch.kind === 'app' ? view.app ?? {} : view.projects?.[ch.id] ?? {};
    ask = askForPatch(patch, scopeName, now);
  }

  // Only Ask can be stored without a key to sign with, so a loosening is refused before any dialog.
  if (ask && view.canSign === false) {
    return { ok: false, error: view.keyUnreadable ? 'Legion could not open its settings key, so only Ask can be used until that is fixed.' : 'Your computer has no safe keystore, so only Ask can be used.' };
  }
  if (ask && !(await deps.confirm(ask))) return { ok: false, cancelled: true };

  let res = await deps.call(method, route, body, ask !== undefined);
  if (!res) return noCore;
  if (!ask && res.status === 403 && /native_confirmation_required/.test(String(res.json?.error ?? ''))) {
    // The core calls this a loosening although the wording logic did not: ask the same way, then send it with the secret.
    if (view.canSign === false) return { ok: false, error: 'Your computer has no safe keystore, so only Ask can be used.' };
    if (!(await deps.confirm(genericAsk(scopeName)))) return { ok: false, cancelled: true };
    res = await deps.call(method, route, body, true);
    if (!res) return noCore;
  }
  return res.status === 200 ? { ok: true, view: res.json } : refused(res);
}

async function projectName(deps: GatesIpcDeps, id: string): Promise<string> {
  try {
    const r = await deps.call('GET', `/api/projects/${id}`);
    const n = r && r.status === 200 ? dialogLine(r.json?.name, 60) : '';
    return n || 'this project';
  } catch { return 'this project'; }
}
