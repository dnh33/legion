/** Pure helpers for the Electron side of the updater (src/electron/updater-main.ts), kept free of electron so they can be tested. */
import { join, resolve, sep } from 'node:path';
import { CODE_SET, FULL_PACKAGE_SET, UPDATE_DIR, type ApplyJob } from './apply.js';
import { BOOT_REASON } from './idle.js';

export interface CommitFacts { installDir: string; stagedDir: string; from: string; to: string; /** The update id the core made when it found this update (journey.ts). */ updateId?: string; /** FULL_PACKAGE_SET for a dependency-change release, omitted for a code-only update. */ names?: readonly string[] }

/** The name sets the core may return, in order. Anything else (or a reordered/edited set) is refused, so a tampered commit answer cannot make the helper swap an arbitrary top-level name. */
const NAME_SETS: readonly (readonly string[])[] = [CODE_SET, FULL_PACKAGE_SET];
export const isKnownNameSet = (names: unknown): names is readonly string[] =>
  Array.isArray(names) && NAME_SETS.some((set) => set.length === names.length && set.every((n, i) => n === names[i]));

/** The commit answer is only used if it describes THIS install and a staged tree inside its own .update folder. */
export function commitMatches(c: unknown, installDir: string, platform: NodeJS.Platform = process.platform): c is CommitFacts {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (![o.installDir, o.stagedDir, o.from, o.to].every((v) => typeof v === 'string' && v.length > 0)) return false;
  if (o.names !== undefined && !isKnownNameSet(o.names)) return false;
  // The full package set (node_modules and runtime) comes only from a Windows full package. Off win32 it can never be a valid commit.
  if (platform !== 'win32' && Array.isArray(o.names) && o.names.length === FULL_PACKAGE_SET.length) return false;
  if (o.updateId !== undefined && !(typeof o.updateId === 'string' && /^[0-9a-f]{8}$/.test(o.updateId))) return false;
  const base = resolve(installDir);
  const staged = resolve(o.stagedDir as string);
  const win = process.platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  return norm(resolve(o.installDir as string)) === norm(base) && norm(staged).startsWith(norm(join(base, UPDATE_DIR, 'staging')) + sep);
}

/** The Chromium switches Legion was started with that the update window must start with too (a machine with no usable GPU or sandbox, such as a CI runner). A normal start has none. */
const WINDOW_SWITCHES = new Set(['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-dev-shm-usage']);
export const windowSwitches = (argv: readonly string[]): string[] => argv.filter((a) => WINDOW_SWITCHES.has(a));

/** The "Updating Legion" window is win32 only (a Linux clone would start a second Electron from it). `setting` is the owner's Settings choice; only a real false turns it off. */
export const windowShown = (platform: NodeJS.Platform, setting: boolean | undefined): boolean => platform === 'win32' && setting !== false;

export function buildJob(c: CommitFacts, o: { parentPid: number; port: number; execPath: string; dataDir?: string; window?: { enabled: boolean; userData: string; args?: string[] }; /** Default: this system. */ platform?: NodeJS.Platform; /** The argv this app was started with. Off win32 its allowlisted switches go to the relaunch. */ argv?: readonly string[] }): ApplyJob {
  // The launcher (scripts/install/install.sh) starts `electron "<dir>" "$@"`, so a user's --no-sandbox is part of how Legion starts there. The relaunch repeats exactly
  // those switches (the same allowlist as the update window), or the new build can fail to start after a clean swap. Windows starts with the install dir only, as before.
  const extra = (o.platform ?? process.platform) !== 'win32' ? windowSwitches(o.argv ?? []) : [];
  return {
    installDir: c.installDir, stagedDir: c.stagedDir, parentPid: o.parentPid, port: o.port, from: c.from, to: c.to,
    ...(c.names ? { names: c.names } : {}),
    ...(c.updateId ? { updateId: c.updateId } : {}),
    ...(o.dataDir ? { dataDir: o.dataDir } : {}),
    ...(o.window ? { window: o.window } : {}),
    // the same command the Start-menu shortcut runs: electron.exe "<install dir>"
    // LEGION_UPDATE_HANDOFF tells the new build it is the helper's own relaunch, so the update marker (which the helper still holds while it
    // waits for this build to report healthy) does not hold the build back from starting. It does not skip the single-instance lock.
    relaunch: { cmd: o.execPath, args: [c.installDir, ...extra], cwd: c.installDir, env: { LEGION_UPDATE_HANDOFF: '1' } },
  };
}

/** Text of the native "Restart now" confirmation: names exactly what will stop. */
export function restartNowText(busy: readonly string[], to: string): { message: string; detail: string; buttons: [string, string] } {
  const work = busy.filter((r) => r !== BOOT_REASON); // a wait for the automatic install, not work: nothing to stop
  const stops = work.length ? work.map((r) => `- ${r}`).join('\n') : '- nothing is running right now';
  return {
    message: `Restart Legion now to install ${to}?`,
    detail: [
      'This will stop:', stops, '',
      'Running tasks are cancelled (they are not resumed automatically; run them again from the task list). Pending approvals are denied.',
      'Cloud VMs are not touched: a running VM keeps running and keeps billing until you stop it.',
      'Your data folder is not changed. If the new version does not start, Legion goes back to the previous one.',
    ].join('\n'),
    buttons: ['Cancel', 'Stop work and restart'],
  };
}
