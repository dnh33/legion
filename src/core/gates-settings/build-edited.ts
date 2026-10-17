/**
 * Which projects have a build or script file an agent changed since the owner last allowed a build or test command there (Task 27).
 * Smart asks for local build and test commands while a project is flagged. The flag is per project and survives a restart:
 * `<dataDir>/gates/build-edited.json`, written atomically. That folder is a protected path, so no file tool or shell can change it.
 *
 * Fails closed: a file that exists but cannot be read flags every project. It is then stored as `{ v: 1, all: true, cleared: [...] }`:
 * the owner's allow in a project adds it to `cleared`, and a later build-file edit there removes it again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildEdited {
  has(projectId: string): boolean;
  set(projectId: string): void;
  clear(projectId: string): void;
}

const ids = (v: unknown): Set<string> | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? new Set(v as string[]) : undefined);

export function createBuildEdited(folder: string): BuildEdited {
  const file = join(folder, 'build-edited.json');
  let all = false;
  let list = new Set<string>(); // the flagged projects, or (when `all`) the projects the owner has cleared since
  const save = (): void => {
    // the flag in memory is what counts: a write that fails (disk full, folder gone) must not turn into an error in a tool call
    try {
      mkdirSync(folder, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all ? { v: 1, all: true, cleared: [...list] } : { v: 1, projects: [...list] }), 'utf8');
      renameSync(tmp, file);
    } catch { /* kept in memory */ }
  };
  if (existsSync(file)) {
    let ok = false;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === 1) {
        const l = raw.all === true ? ids(raw.cleared) : ids(raw.projects);
        if (l) { all = raw.all === true; list = l; ok = true; }
      }
    } catch { /* unreadable: handled below */ }
    if (!ok) { all = true; list = new Set(); save(); }
  }
  /** Adds or removes one id from `list`; writes only when that changed something. */
  const change = (id: string, add: boolean): void => {
    if (add === list.has(id)) return;
    if (add) list.add(id); else list.delete(id);
    save();
  };
  return {
    has: (id) => (all ? !list.has(id) : list.has(id)),
    set: (id) => change(id, !all), // all: a flagged project is one that is NOT in `cleared`
    clear: (id) => change(id, all),
  };
}
