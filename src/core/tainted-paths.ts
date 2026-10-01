/**
 * Which files in an agent's workspace hold content that a tainted run wrote.
 *
 * A run that touched outside content (web, shell, external MCP tools) and then Writes or Edits a file has put that content on
 * disk. A later run, which is not tainted, would read it back as "its own files". This set remembers those paths (persisted
 * as JSON so a restart does not forget) and the engine taints any run that later reads one of them.
 *
 * Limits, stated plainly: it follows file tools only. Content a tainted run wrote with Bash, copied, renamed, or reached
 * through a symlink or hard link is not tracked (a tainted run's Bash already taints that run, but not the files it leaves).
 * Grep, Glob and LS taint when the tree they search holds any marked file, whether or not it matches. A bot that runs as the
 * same user can edit the JSON file. Entries expire after 30 days, vanish when a clean run rewrites the
 * whole file, and the list holds at most 2000 paths (the oldest go first). To clear it by hand, delete the file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const MAX_PATHS = 2000;
const EXPIRES_MS = 30 * 24 * 3600 * 1000;

const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

export class TaintedPaths {
  private marks = new Map<string, number>();

  constructor(private readonly file?: string, private readonly now: () => number = () => Date.now()) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { paths?: Record<string, number> };
        for (const [p, t] of Object.entries(raw.paths ?? {})) if (typeof t === 'number') this.marks.set(p, t);
      } catch { /* an unreadable list starts empty */ }
    }
  }

  /** Absolute path for a tool argument (relative paths are the agent's working directory). */
  static resolvePath(cwd: string, p: string): string { return norm(resolve(cwd, p)); }

  mark(abs: string): void {
    const p = norm(abs);
    this.marks.delete(p);
    this.marks.set(p, this.now());
    while (this.marks.size > MAX_PATHS) this.marks.delete(this.marks.keys().next().value as string);
    this.save();
  }

  /** A clean run replaced the whole file: its content is no longer the tainted run's. */
  unmark(abs: string): void { if (this.marks.delete(norm(abs))) this.save(); }

  /** True when this exact file holds tainted content. */
  has(abs: string): boolean {
    const p = norm(abs);
    const t = this.marks.get(p);
    if (t === undefined) return false;
    // no existence check: the mark is made by the hook BEFORE the Write runs, and a deleted file may be written again
    if (this.now() - t > EXPIRES_MS) { this.unmark(p); return false; }
    return true;
  }

  /** True when the file, or any file under this directory, holds tainted content. */
  touches(root: string): boolean {
    const r = norm(root);
    for (const p of [...this.marks.keys()]) {
      if (p !== r) {
        const rel = relative(r, p);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
      }
      if (this.has(p)) return true;
    }
    return false;
  }

  size(): number { return this.marks.size; }

  clear(): void { this.marks.clear(); this.save(); }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ paths: Object.fromEntries(this.marks) }), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* best effort: the in-memory list still works for this run of the app */ }
  }
}
