import { isSecretPath } from './secret-paths.js';

/**
 * What one run has done on the web, kept on the run's `Active` (never stored). Feeds the web check (src/shared/web-verdict.ts):
 * how many distinct paths the run read on a host (the path budget), whether a secret file was read in the run, and the sites the
 * owner allowed for the length of this goal.
 */
export class WebSession {
  private readonly paths = new Map<string, Set<string>>();
  private readonly goalSites = new Set<string>();
  private secretFileRead = false;

  /** A read of `path` on `host` went through. The budget counts distinct paths, so the same page twice counts once. */
  noteFetch(host: string, path: string): void {
    let set = this.paths.get(host);
    if (!set) { set = new Set(); this.paths.set(host, set); }
    set.add(path);
  }
  pathsSeen(host: string): number { return this.paths.get(host)?.size ?? 0; }

  /** A file was read in this run. If it is a secret file (an env file, a key), every web call asks from now on. */
  noteRead(path: string): void { if (isSecretPath(path)) this.secretFileRead = true; }
  get secretRead(): boolean { return this.secretFileRead; }

  /** The owner answered "Allow for this goal" on a card: that site opens without asking for the rest of the run. */
  trustForGoal(host: string): void { this.goalSites.add(host); }
  goalTrusts(host: string): boolean { return this.goalSites.has(host); }
}
