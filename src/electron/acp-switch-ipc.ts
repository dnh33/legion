/**
 * Native confirmation for the Hermes switches that let Hermes ask less (Stop disaster commands off, Ignore Hermes's skip-approval settings off,
 * Answer each request once off, Match Legion's mode on). The window names a change; this code reads the switches from the core itself, works out
 * what would loosen, shows a native dialog with one plain line per loosening, and only after "Confirm" saves with the native secret, which the
 * window never has. A change that keeps or tightens every switch needs no dialog and no secret. The core refuses a loosening without the secret.
 * Kept free of electron imports so it can be tested with fakes.
 */
import { LOOSEN_LINES, SWITCH_ORDER, loosenedSwitches } from '../shared/acp-copy.js';
import type { AcpSwitches } from '../shared/acp-view.js';
import { dialogLine } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';

export interface AcpSwitchChange { switches: Partial<AcpSwitches> }
export interface AcpSwitchResult { ok: boolean; error?: string; cancelled?: boolean; view?: unknown }
export interface AcpSwitchIpcDeps {
  /** A request to our own core with the admin secret, and the native secret when `native` is true. undefined = no proven core. */
  call(method: 'GET' | 'PATCH', route: string, body?: unknown, native?: boolean): Promise<CoreReply | undefined>;
  /** A native dialog (Cancel is the default button). Resolves true only for the confirm button. */
  confirm: ProviderIpcDeps['confirm'];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Strict parse of what the window sent: only the four switches, each true or false, at least one. */
export function parseAcpSwitchChange(raw: unknown): AcpSwitchChange | undefined {
  if (!isObj(raw) || Object.keys(raw).length !== 1 || !isObj(raw.switches)) return undefined;
  const out: Partial<AcpSwitches> = {};
  for (const [k, v] of Object.entries(raw.switches)) {
    if (!(SWITCH_ORDER as readonly string[]).includes(k) || typeof v !== 'boolean') return undefined;
    out[k as keyof AcpSwitches] = v;
  }
  return Object.keys(out).length ? { switches: out } : undefined;
}

let open = false;
export function resetAcpSwitchForTests(): void { open = false; }

export async function acpSwitchChange(raw: unknown, deps: AcpSwitchIpcDeps): Promise<AcpSwitchResult> {
  const ch = parseAcpSwitchChange(raw);
  if (!ch) return { ok: false, error: 'That request was not understood.' };
  const cur = await deps.call('GET', '/api/settings');
  const now = cur?.status === 200 ? cur.json?.acp?.switches : undefined;
  if (!cur) return { ok: false, error: 'Legion could not reach its own core. Restart Legion.' };
  if (!isObj(now) || SWITCH_ORDER.some((k) => typeof now[k] !== 'boolean')) return { ok: false, error: 'Legion could not read the Hermes switches, so nothing was changed.' };
  const loosened = loosenedSwitches(now as unknown as AcpSwitches, ch.switches);
  if (loosened.length > 0) {
    if (open) return { ok: false, error: 'A confirmation is already open. Answer it first.' };
    open = true;
    try {
      const go = await deps.confirm({
        title: 'Let Hermes ask you less?',
        message: loosened.length === 1 ? 'This change lets Hermes ask you less.' : 'These changes let Hermes ask you less.',
        detail: loosened.map((k) => LOOSEN_LINES[k]).join('\n\n'),
        confirmLabel: 'Confirm change',
      });
      if (!go) return { ok: false, cancelled: true };
    } finally { open = false; }
  }
  const res = await deps.call('PATCH', '/api/settings', { acp: { switches: ch.switches } }, loosened.length > 0);
  if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
  if (res.status !== 200) return { ok: false, error: dialogLine(res.json?.error, 300) || `The core refused the change (${res.status}).` };
  return { ok: true, view: res.json };
}
