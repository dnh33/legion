/**
 * The one route that changes the mainnet hard-off switch: `POST /api/bsv/policy/mainnet` with `{enabled: boolean}`.
 *
 *  - It is not on the MCP client list in admin.ts, so the bearer token reaches nothing here (default-deny gate: the admin secret is required).
 *  - ENABLE needs the native secret that only the Electron main process holds, which main presents after its own native dialog (kind
 *    `mainnet-enable`: the warning, Cancel as default and Escape). It is refused while BSV mode is off or the chain is frozen. The new
 *    state is saved BEFORE it is applied, so a failed save leaves the switch off.
 *  - DISABLE needs the admin secret only: no dialog, no native secret, and it works while frozen or with BSV mode off. It can only make
 *    Legion safer (it also disarms and voids pending mainnet cards), the same reasoning as Freeze and Disarm.
 *  - Switching off by any other path (a mainnet unknown outcome, a post-sign mismatch, an audit failure, a tampered policy file) goes through
 *    `policy.mainnetOff`; the hook registered here saves the file and writes the audit line for every one of them, so a restart cannot bring
 *    the switch back on.
 *
 * Everything is injected (index.ts passes its own `requireNative`, `persistPolicy` and `note`), so this file reads no file, calls no wallet
 * and imports nothing that does. The switch is a policy state; this file never spends and holds no key.
 */
import { HttpError } from '../server.js';
import type { RouteAdder } from '../modules.js';
import { PolicyError } from './policy.js';
import type { PolicyConfig, PolicyEngine } from './policy.js';

export const MAINNET_ROUTE = '/api/bsv/policy/mainnet';

export interface MainnetRouteDeps {
  policy: PolicyEngine;
  /** Throws HttpError 403 unless the request carries the per-launch native secret (index.ts `requireNative`). */
  requireNative: (req: { headers?: Record<string, string | string[] | undefined> } | undefined) => void;
  /** Notices a policy file that changed outside Legion (freezes and keeps evidence). Runs before anything here reads or changes the policy. */
  checkPolicyFile: () => void;
  /** Saves the policy file and records its hash in the audit log (index.ts `persistPolicy`). False = could not save. */
  persist: (cfg?: PolicyConfig) => boolean;
  /** One audit line (index.ts `note`). */
  note: (agent: string, tool: string, decision: string, reason?: string, fields?: Record<string, unknown>) => void;
  /** BSV mode is on. */
  bsvEnabled: () => boolean;
  /** The policy view the other policy routes return. */
  view: () => unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Registers the route and the hook that saves every switch-off; the one-line wiring in bsv/index.ts passes { policy, requireNative, checkPolicyFile, persist, note, bsvEnabled, view }. */
export function registerMainnetRoutes(add: RouteAdder, deps: MainnetRouteDeps): void {
  const { policy } = deps;
  let ownerAction = false;
  /** The result of the save the hook did on the latest on -> off change (null = the hook did not run). */
  let hookSaved: boolean | null = null;
  // every on -> off change, whoever caused it, is saved and logged here; a failed save freezes (in memory) rather than leave the file saying "on"
  policy.setMainnetOffHook((reason) => {
    const saved = deps.persist();
    hookSaved = saved;
    deps.note(ownerAction ? 'owner' : 'legion', 'policy', 'mainnet-off', reason, { saved });
    if (!saved) policy.freeze('the mainnet switch could not be saved, so the policy file may still say it is on');
  });

  add('POST', MAINNET_ROUTE, ({ req, body }) => {
    const enabled = isObj(body) && Object.keys(body).length === 1 ? body.enabled : undefined;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'body {enabled:boolean} required');
    if (!enabled) {
      // the safer direction: admin secret only (the gate), no dialog, available whatever else is going on
      deps.checkPolicyFile();
      ownerAction = true; hookSaved = null;
      try { policy.mainnetOff('switched off by the owner'); } finally { ownerAction = false; }
      // Disable always writes the file and reports THAT result, even when the switch was already off in memory (the file may still say on)
      let persisted = hookSaved as boolean | null; // set by the hook above
      if (persisted === null) {
        persisted = deps.persist();
        deps.note('owner', 'policy', 'mainnet-off', 'switched off by the owner (it was already off in memory; the file was written again)', { saved: persisted });
        if (!persisted) policy.freeze('the mainnet switch could not be saved, so the policy file may still say it is on');
      }
      return { ...(deps.view() as object), persisted };
    }
    deps.requireNative(req);
    deps.checkPolicyFile();
    if (!deps.bsvEnabled()) throw new HttpError(409, 'Turn BSV mode on first.');
    if (policy.isFrozen) throw new HttpError(409, 'The chain is frozen: unfreeze it first.');
    if (!policy.mainnetEnabled) {
      // saved first: if the disk refuses, the switch stays off
      if (!deps.persist({ ...policy.config(), mainnetEnabled: true })) throw new HttpError(500, 'Could not save the change, so mainnet stays off.');
      try { policy.setMainnetEnabled(true); } catch (e) { if (e instanceof PolicyError) throw new HttpError(409, e.message); throw e; }
      deps.note('owner', 'policy', 'mainnet-on', 'the owner switched mainnet on after the native dialog');
    }
    return deps.view();
  });
}
