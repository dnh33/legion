/** Pure helpers for the Electron side of the updater (src/electron/updater-main.ts), kept free of electron so they can be tested. */
import { join, resolve, sep } from 'node:path';
import { UPDATE_DIR, type ApplyJob } from './apply.js';

export interface CommitFacts { installDir: string; stagedDir: string; from: string; to: string }

/** The commit answer is only used if it describes THIS install and a staged tree inside its own .update folder. */
export function commitMatches(c: unknown, installDir: string): c is CommitFacts {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (![o.installDir, o.stagedDir, o.from, o.to].every((v) => typeof v === 'string' && v.length > 0)) return false;
  const base = resolve(installDir);
  const staged = resolve(o.stagedDir as string);
  const win = process.platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  return norm(resolve(o.installDir as string)) === norm(base) && norm(staged).startsWith(norm(join(base, UPDATE_DIR, 'staging')) + sep);
}

export function buildJob(c: CommitFacts, o: { parentPid: number; port: number; execPath: string }): ApplyJob {
  return {
    installDir: c.installDir, stagedDir: c.stagedDir, parentPid: o.parentPid, port: o.port, from: c.from, to: c.to,
    // the same command the Start-menu shortcut runs: electron.exe "<install dir>"
    relaunch: { cmd: o.execPath, args: [c.installDir], cwd: c.installDir },
  };
}

/** Text of the native "Restart now" confirmation: names exactly what will stop. */
export function restartNowText(busy: readonly string[], to: string): { message: string; detail: string; buttons: [string, string] } {
  const stops = busy.length ? busy.map((r) => `- ${r}`).join('\n') : '- nothing is running right now';
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
