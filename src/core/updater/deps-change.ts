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
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { Manifest } from './manifest.js';

export type ReleaseRoute = 'code' | 'full' | 'notify';

/**
 * What a person on Mac or Linux is told when a release changes dependencies. Those installs never apply a full package (it is a
 * Windows package). The installer rebuilds node_modules under the running app, so the person must close Legion first. The installer
 * puts Legion in ~/.local/share/legion unless told otherwise, so an install made with --dir needs --dir again, or the installer would
 * build a second copy and point the launcher at it. `installRoot` is the folder Legion runs from; `home` is for tests.
 */
export function unixDepsText(installRoot?: string, home: string = homedir()): string {
  const std = posix.join(home, '.local', 'share', 'legion');
  const isDefault = installRoot === undefined || installRoot === std || sameFolder(installRoot, std);
  const dir = isDefault ? '' : ` -s -- --dir '${installRoot.replace(/'/g, `'\''`)}'`;
  return `This update changes Legion's dependencies. On Mac and Linux, close Legion, then run the installer again: curl -fsSL https://getlegion.xyz | sh${dir} (your data in ~/.legion stays).`;
}
const sameFolder = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
export const UNIX_DEPS_TEXT = unixDepsText();
/** A route value read from outside (parse-ahead for a later release): anything this build does not know is a notice, never an action. */
export function parseRoute(v: unknown): ReleaseRoute {
  return v === 'code' || v === 'full' || v === 'notify' ? v : 'notify';
}
export interface ReleasePlan { route: ReleaseRoute; reason: string }

/** A short, non-secret fingerprint of the release's dependency hash, for the reason string only. */
const deps = (m: Pick<Manifest, 'depsSha256'>): string => `depsSha256 ${m.depsSha256.slice(0, 12)}…`;

/**
 * Decide the route for a verified manifest. Pure: no network, no disk. Off win32 a dependency release is always `notify`: the signed
 * full package is a Windows package and must never be requested there.
 *
 * Only `requiresFullInstall` (plus the presence of a signed `fullAsset`) is consulted; the installed dependency hash is
 * not needed to route, because the code-only stager fails closed on a real mismatch and index.ts escalates that to the
 * full package when one is signed.
 */
export function planRelease(m: Pick<Manifest, 'requiresFullInstall' | 'depsSha256' | 'fullAsset'>, platform: NodeJS.Platform, installRoot?: string): ReleasePlan {
  if (!m.requiresFullInstall) return { route: parseRoute('code'), reason: 'the release does not change dependencies' };
  if (platform !== 'win32') return { route: 'notify', reason: `the release changes dependencies (${deps(m)}): ${unixDepsText(installRoot)}` };
  if (m.fullAsset) return { route: 'full', reason: `the release changes dependencies (${deps(m)}) and ships a signed full package` };
  return { route: 'notify', reason: `the release changes dependencies (${deps(m)}) and carries no signed full package: download its source and run setup.cmd` };
}
