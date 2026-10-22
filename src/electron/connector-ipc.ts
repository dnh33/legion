/**
 * Settings, Connectors, GitHub, "Connect": main drives the whole thing (design 4.4 "Hand-off", the restart fallback).
 *
 * The core's stdin is closed after the launch secrets, so a core that started without a connectors key can only get one by a restart.
 * Order, with the sign-in never before the key:
 *   1. ask the core; if the GitHub App is not registered, say so and stop;
 *   2. no key in the core: confirm (a restart stops running tasks), make and wrap the key (`ensureKey`, the first safeStorage use),
 *      restart the core (it reads key.bin at launch and receives the KEY line), check the core now reports the key;
 *      when the keystore cannot be used, offer "sign in without remembering" (memory only) instead;
 *   3. only then start the device flow on the core and open the fixed GitHub page.
 * Free of electron imports so it is tested with fakes.
 */
import type { GithubApp } from '../shared/github-area.js';
import { CONFIRM_BUSY, orBusy } from './confirm-window-logic.js';
import { ASKED_BY } from './provider-ipc.js';
import type { CoreReply, ProviderIpcDeps } from './provider-ipc.js';

export const GITHUB_DEVICE_PAGE_URL = 'https://github.com/login/device';

export interface ConnectorIpcDeps {
  call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<CoreReply | undefined>;
  confirm: ProviderIpcDeps['confirm'];
  /** Makes (or reads) the wrapped key. undefined: the keystore cannot be used. */
  ensureKey(): Promise<string | undefined>;
  /** Restarts the core; null on success, else a plain error. */
  restartCore(): Promise<string | null>;
  /** Opens an address in the browser. Called only with GITHUB_DEVICE_PAGE_URL. */
  openExternal(url: string): void;
}
export interface ConnectResult { ok: boolean; error?: string; cancelled?: boolean; restarted?: boolean; memoryOnly?: boolean }

let busy = false;

/** `app` picks which GitHub App signs in: read (the default, as before) or write. Each has its own sign-in route on the core. */
export const connectGithub = (deps: ConnectorIpcDeps, app: GithubApp = 'read'): Promise<ConnectResult> => orBusy(connectGithubRun(deps, app), { ok: false, error: CONFIRM_BUSY });
async function connectGithubRun(deps: ConnectorIpcDeps, app: GithubApp = 'read'): Promise<ConnectResult> {
  if (app !== 'read' && app !== 'write') return { ok: false, error: 'That GitHub App cannot be signed in here.' };
  if (busy) return { ok: false, error: 'A connect is already in progress.' };
  busy = true;
  try {
    let st = await deps.call('GET', '/api/connectors/github');
    if (!st || st.status !== 200) return { ok: false, error: 'Legion could not reach its own core. Restart Legion.' };
    if ((app === 'write' ? st.json?.writeAvailable : st.json?.available) !== true) return { ok: false, error: 'GitHub sign-in is not available yet: the Legion GitHub App is not registered in this build.' };
    let restarted = false;
    let memoryOnly = false;
    if (st.json?.key !== 'installed') {
      const state = await deps.call('GET', '/api/state');
      const running = Array.isArray(state?.json?.tasks) && state!.json.tasks.some((t: { status?: string }) => t.status === 'running' || t.status === 'queued');
      const go = await deps.confirm({
        title: 'Restart Legion Core to connect GitHub?', message: 'Legion needs to restart its core once to store the GitHub sign-in encrypted.',
        detail: (running ? 'Tasks that are running now will be stopped and pending approvals cancelled. ' : '') + 'This happens once, on the first connect. The window reloads and opens Settings, GitHub, where your sign-in code appears; your browser opens the GitHub page.',
        confirmLabel: 'Restart and connect', who: ASKED_BY.connectors, tone: 'danger', toneTag: 'RESTARTS CORE',
      });
      if (!go) return { ok: false, cancelled: true };
      // the first use of the system keystore happens here, after the owner said yes (never at app start)
      const hex = await deps.ensureKey().then((h) => h, () => undefined);
      if (hex === undefined) {
        const mem = await deps.confirm({
          title: 'Sign in without remembering?', message: 'Your computer cannot keep the GitHub sign-in safely.',
          detail: 'Legion has no usable system keystore here (on Linux: no keyring). You can still sign in, but you will have to do it again each time Legion starts. Nothing is restarted.',
          confirmLabel: 'Sign in each launch', who: ASKED_BY.connectors,
        });
        if (!mem) return { ok: false, cancelled: true };
        memoryOnly = true;
      } else {
        const err = await deps.restartCore();
        if (err) return { ok: false, error: err };
        restarted = true;
        st = await deps.call('GET', '/api/connectors/github');
        if (!st || st.status !== 200 || st.json?.key !== 'installed') return { ok: false, error: 'The core restarted but did not receive the key. Try Connect again, or restart Legion.' };
      }
    }
    const res = await deps.call('POST', app === 'write' ? '/api/github/apps/write/connect' : '/api/connectors/github/connect', memoryOnly ? { memoryOnly: true } : {});
    if (!res) return { ok: false, error: 'Legion could not reach its own core.' };
    if (res.status !== 200) return { ok: false, error: res.json?.error === 'needs-key' ? 'The core has no key yet. Try again.' : res.json?.error === 'not-available' ? 'GitHub sign-in is not available yet.' : `The core refused (${res.status}).` };
    if (res.json?.phase === 'failed') return { ok: false, error: typeof res.json.message === 'string' ? res.json.message : 'GitHub did not accept the sign-in.' };
    // the page is the fixed one, whatever the core said
    deps.openExternal(GITHUB_DEVICE_PAGE_URL);
    return { ok: true, restarted, memoryOnly };
  } finally { busy = false; }
}
