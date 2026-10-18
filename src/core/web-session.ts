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
  private readonly approvedSites = new Set<string>();

  /** A read of `path` on `host` went through. The budget counts distinct paths, so the same page twice counts once. */
  noteFetch(host: string, path: string): void {
    let set = this.paths.get(host);
    if (!set) { set = new Set(); this.paths.set(host, set); }
    set.add(path);
  }
  pathsSeen(host: string): number { return this.paths.get(host)?.size ?? 0; }

  /** The owner answered yes on a card for a site this run had not been allowed to read: it counts as one new site for the run. */
  noteNewSite(host: string): void { if (host) this.approvedSites.add(host); }

  /** What the run read, as counts only: distinct pages (host and path) and the new sites the owner approved. Never an address or a query. */
  summary(): { pages: number; newSites: number } {
    let pages = 0;
    for (const set of this.paths.values()) pages += set.size;
    return { pages, newSites: this.approvedSites.size };
  }

  /** A file was read in this run. If it is a secret file (an env file, a key), every web call asks from now on. */
  noteRead(path: string): void { if (isSecretPath(path)) this.secretFileRead = true; }
  /** The engine found a secret read by where the file is (Legion's own key files), not by its name. */
  noteSecretRead(): void { this.secretFileRead = true; }
  get secretRead(): boolean { return this.secretFileRead; }

  /** The owner answered "Allow for this goal" on a card: that site opens without asking for the rest of the run. */
  trustForGoal(host: string): void { this.goalSites.add(host); }
  goalTrusts(host: string): boolean { return this.goalSites.has(host); }
}
