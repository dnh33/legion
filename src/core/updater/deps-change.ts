/**
 * The dependency-change bridge (0.2.5-o): decides, from the SIGNED manifest alone, how a release can be applied.
 *
 * `requiresFullInstall` is set by the release owner exactly when the release's `package-lock.json` dependency content
 * changed (see docs/adr/0004-dependency-hash.md and docs/VERSIONING.md). The app package carries the code set only and
 * no `node_modules`, so such a release cannot be applied by the code-only swap: it needs the full package
 * (`legion-<version>-win-x64.zip`), which also replaces `node_modules` and `runtime`. This module only ROUTES:
 *
 *   - `code`   — a plain release; the app package applies in place (the existing swap).
 *   - `full`   — a dependency-change release whose manifest signs a `fullAsset`; stage and apply that full package.
 *   - `notify` — a dependency-change release with no signed full package: the human fallback (download the source and
 *                run setup.cmd). This is also what an install predating full-package support gets, unchanged.
 *
 * The byte-level proof that the dependencies really changed happens later, at staging time: package.ts compares the
 * installed dependency hash with the release lock's (`checkTree`). That is what catches a lock that changed without the
 * flag, and it escalates a `code` route to the full package when one is signed. Routing here needs no download.
 */
import type { Manifest } from './manifest.js';

export type ReleaseRoute = 'code' | 'full' | 'notify';
export interface ReleasePlan { route: ReleaseRoute; reason: string }

/** A short, non-secret fingerprint of the release's dependency hash, for the reason string only. */
const deps = (m: Pick<Manifest, 'depsSha256'>): string => `depsSha256 ${m.depsSha256.slice(0, 12)}…`;

/**
 * Decide the route for a verified manifest. Pure: no network, no disk.
 *
 * Only `requiresFullInstall` (plus the presence of a signed `fullAsset`) is consulted; the installed dependency hash is
 * not needed to route, because the code-only stager fails closed on a real mismatch and index.ts escalates that to the
 * full package when one is signed.
 */
export function planRelease(m: Pick<Manifest, 'requiresFullInstall' | 'depsSha256' | 'fullAsset'>): ReleasePlan {
  if (!m.requiresFullInstall) return { route: 'code', reason: 'the release does not change dependencies' };
  if (m.fullAsset) return { route: 'full', reason: `the release changes dependencies (${deps(m)}) and ships a signed full package` };
  return { route: 'notify', reason: `the release changes dependencies (${deps(m)}) and carries no signed full package: download its source and run setup.cmd` };
}
