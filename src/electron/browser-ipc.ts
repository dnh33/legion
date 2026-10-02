/**
 * Native confirmation for the browser tool changes that decide what Legion runs or which addresses a page may reach: choosing the Lightpanda
 * program (or its launcher arguments, or the hash Legion trusts) and "allow local addresses" on listed ports. The window asks over IPC; this code
 * words a native dialog from the request it parsed itself, and only after "Confirm" calls the core with the native secret, which the window never
 * has. Cancel is the default button. Kept free of electron imports so it can be tested with fakes.
 */
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';

export interface BrowserIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'POST', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  confirm: ProviderIpcDeps['confirm'];
}
export type BrowserChange =
  | { kind: 'program'; binaryPath: string; launcherArgs: string[] }
  | { kind: 'hash'; sha256: string }
  | { kind: 'local'; allow: boolean; ports: number[] };
export interface BrowserChangeResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(s);

/** Strict parse of what the window sent; anything else is refused. */
export function parseBrowserChange(raw: unknown): BrowserChange | undefined {
  if (!isObj(raw)) return undefined;
  if (raw.kind === 'program') {
    if (!plain(raw.binaryPath, 500)) return undefined;
    const args = raw.launcherArgs === undefined ? [] : raw.launcherArgs;
    if (!Array.isArray(args) || args.length > 16 || args.some((a) => !plain(a, 500))) return undefined;
    return { kind: 'program', binaryPath: raw.binaryPath, launcherArgs: args as string[] };
  }
  if (raw.kind === 'hash') return typeof raw.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(raw.sha256) ? { kind: 'hash', sha256: raw.sha256.toLowerCase() } : undefined;
  if (raw.kind === 'local') {
    if (typeof raw.allow !== 'boolean') return undefined;
    const ports = raw.ports === undefined ? [] : raw.ports;
    if (!Array.isArray(ports) || ports.length > 20 || ports.some((p) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)) return undefined;
    return { kind: 'local', allow: raw.allow, ports: ports as number[] };
  }
  return undefined;
}

let open = false;

export async function browserChange(raw: unknown, deps: BrowserIpcDeps): Promise<BrowserChangeResult> {
  const ch = parseBrowserChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', '/api/browser');
  if (!cur || cur.status !== 200) return { ok: false, error: 'Legion could not reach its own core. Restart Legion.' };
  let title: string; let message: string; let detail: string; let confirmLabel: string; let route: string; let body: unknown;
  if (ch.kind === 'program') {
    title = 'Run this program for the browser tool?'; confirmLabel = 'Allow this program';
    message = 'Let Legion start this program when an agent opens a web page?';
    detail = `Program: ${dialogLine(ch.binaryPath, 200)}${ch.launcherArgs.length ? `\nArguments: ${dialogLine(ch.launcherArgs.join(' '), 300)}` : ''}\n\nLegion will run it on this computer with your user rights, once for each task that opens a page, whenever the browser tool is switched on. Only continue if you chose this program yourself.`;
    route = '/api/browser/config'; body = { binaryPath: ch.binaryPath, launcherArgs: ch.launcherArgs };
  } else if (ch.kind === 'hash') {
    title = 'Trust this download hash?'; confirmLabel = 'Trust this hash';
    message = 'Record the checksum Legion will accept for the Lightpanda download?';
    detail = `sha256 ${ch.sha256}\n\nLegion will only make a downloaded Lightpanda runnable if it matches this value exactly. Copy it from the release page yourself; do not accept a value someone else gave you.`;
    route = '/api/browser/config'; body = { managedSha256: ch.sha256 };
  } else if (ch.allow) {
    title = 'Allow local addresses?'; confirmLabel = 'Allow until restart';
    message = 'Let agents open pages on this computer or your private network?';
    detail = `Only on these ports: ${ch.ports.length ? ch.ports.join(', ') : '(none, so nothing is reachable)'}.\n\nThis lasts until Legion restarts. Pages on your own network are then reachable by an agent that read untrusted text. One port that belongs to your BSV wallet stays blocked whatever you choose here.`;
    route = '/api/browser/local'; body = { allow: true, ports: ch.ports };
  } else {
    title = 'Turn local addresses off?'; confirmLabel = 'Turn off'; message = 'Stop agents from opening pages on this computer or your private network?'; detail = 'This is the default.';
    route = '/api/browser/local'; body = { allow: false, ports: [] };
  }
  if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
  open = true;
  try { if (!(await deps.confirm({ title, message, detail, confirmLabel }))) return { ok: false, cancelled: true }; } finally { open = false; }
  const res = await deps.call('POST', route, body, true);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
  return { ok: true, view: res.json };
}
