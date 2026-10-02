/** Projects: the owner's groups of work. Own file (<dataDir>/projects.json) so an older build's rewrite of state.json cannot drop them. */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { PROJECT_LIMITS } from '../../shared/projects.js';
import type { Project, ProjectStatus } from '../../shared/projects.js';
import { newId, nowIso } from '../../shared/util.js';

export class ProjectError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProjectError'; }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
/** Text for instructions: keep newlines and tabs, drop other control characters and bidi controls. */
const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');

export const cleanName = (v: unknown): string => {
  if (typeof v !== 'string') throw new ProjectError(400, 'name must be a string');
  const n = oneLine(v);
  if (!n) throw new ProjectError(400, 'name must not be empty');
  if (n.length > PROJECT_LIMITS.nameChars) throw new ProjectError(400, `name is too long (max ${PROJECT_LIMITS.nameChars} characters)`);
  return n;
};
/** Instructions are clipped, not refused: the page shows the counter. */
export const cleanInstructions = (v: unknown): string => {
  if (typeof v !== 'string') throw new ProjectError(400, 'instructions must be a string');
  return cleanText(v).slice(0, PROJECT_LIMITS.instructionsChars);
};

const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const within = (child: string, parent: string): boolean => {
  if (same(child, parent)) return true;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return process.platform === 'win32' ? child.toLowerCase().startsWith(p.toLowerCase()) : child.startsWith(p);
};
/** Resolves symlinks/junctions of the deepest existing ancestor, so a link cannot hide where a folder really is. */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    tail.push(cur.slice(up.length).replace(/^[\\/]+/, ''));
    cur = up;
  }
}

/**
 * A folder a project may use: absolute, not a filesystem root, not Legion's data directory (config, tokens, state) or inside it or above it,
 * and not overlapping another project's folder. Returns the resolved path.
 */
export function validateFolder(raw: unknown, ctx: { dataDir: string; workspaceDir: string; others: Array<{ id: string; folder: string }>; selfId?: string }): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 400 || /[\u0000-\u001f]/.test(raw)) throw new ProjectError(400, 'folder must be a path (max 400 characters)');
  if (!isAbsolute(raw)) throw new ProjectError(400, 'folder must be an absolute path');
  const folder = realish(raw);
  if (same(folder, parse(folder).root)) throw new ProjectError(400, 'folder cannot be a drive or filesystem root');
  const data = realish(ctx.dataDir);
  // the default workspace sits inside the data folder: only its projects/ area is open (config, tokens, state and the taint list are not)
  const projectsArea = realish(join(ctx.workspaceDir, 'projects'));
  const inArea = within(folder, projectsArea) && !same(folder, projectsArea);
  if (!inArea && (within(folder, data) || within(data, folder))) throw new ProjectError(400, 'folder cannot be Legion\'s data folder, inside it, or a folder that contains it');
  for (const o of ctx.others) {
    if (o.id === ctx.selfId) continue;
    const of = realish(o.folder);
    if (within(folder, of) || within(of, folder)) throw new ProjectError(409, 'folder overlaps another project\'s folder');
  }
  return folder;
}

const DEBOUNCE_MS = 200;

export class ProjectStore {
  private readonly projects = new Map<string, Project>();
  /** Fields of a later build that this build does not know: kept on write. */
  private readonly extras = new Map<string, Record<string, unknown>>();
  private topExtra: Record<string, unknown> = {};
  private readonly file: string;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  /** `workspaceDir` is where default folders go (<workspaceDir>/projects/<id>). `dataDir` is Legion's data directory (off limits as a folder). */
  constructor(readonly dataDir: string, private readonly workspaceDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'projects.json');
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!isObj(raw)) throw new Error('not an object');
      const { projects, version: _v, ...rest } = raw;
      this.topExtra = rest;
      for (const p of Array.isArray(projects) ? projects : []) this.load(p);
    } catch {
      try { renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    }
  }

  private load(p: unknown): void {
    if (!isObj(p) || typeof p.id !== 'string' || !/^proj_[a-f0-9]{12}$/.test(p.id) || typeof p.name !== 'string') return;
    const { id, name, instructions, folder, members, status, createdAt, updatedAt, ...extra } = p;
    const proj: Project = {
      id, name: oneLine(name).slice(0, PROJECT_LIMITS.nameChars) || 'Project',
      instructions: typeof instructions === 'string' ? cleanText(instructions).slice(0, PROJECT_LIMITS.instructionsChars) : '',
      folder: typeof folder === 'string' && isAbsolute(folder) ? folder : this.defaultFolder(id),
      members: Array.isArray(members) ? [...new Set(members.filter((m): m is string => typeof m === 'string'))].slice(0, PROJECT_LIMITS.members) : [],
      status: status === 'archived' ? 'archived' : 'active',
      createdAt: typeof createdAt === 'string' ? createdAt : nowIso(), updatedAt: typeof updatedAt === 'string' ? updatedAt : nowIso(),
    };
    this.projects.set(id, proj);
    if (Object.keys(extra).length) this.extras.set(id, extra);
  }

  defaultFolder(id: string): string { return join(this.workspaceDir, 'projects', id); }

  list(): Project[] { return [...this.projects.values()].map((p) => structuredClone(p)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  get(id: string): Project | undefined { const p = this.projects.get(id); return p ? structuredClone(p) : undefined; }

  create(input: { name: unknown; instructions?: unknown }): Project {
    if (this.projects.size >= PROJECT_LIMITS.projects) throw new ProjectError(409, `Legion keeps at most ${PROJECT_LIMITS.projects} projects. Archive or reuse one.`);
    const now = nowIso();
    let id = '';
    do { id = newId('proj'); } while (this.projects.has(id));
    const p: Project = {
      id, name: cleanName(input.name), instructions: input.instructions === undefined ? '' : cleanInstructions(input.instructions),
      folder: this.defaultFolder(id), members: [], status: 'active', createdAt: now, updatedAt: now,
    };
    this.projects.set(id, p);
    this.touch();
    return structuredClone(p);
  }

  /** Name, instructions and status: the owner's plain edits (no native confirmation needed). */
  update(id: string, patch: { name?: unknown; instructions?: unknown; status?: unknown }): Project {
    const p = this.must(id);
    if (patch.name !== undefined) p.name = cleanName(patch.name);
    if (patch.instructions !== undefined) p.instructions = cleanInstructions(patch.instructions);
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'archived') throw new ProjectError(400, 'status must be active or archived');
      p.status = patch.status as ProjectStatus;
    }
    p.updatedAt = nowIso();
    this.touch();
    return structuredClone(p);
  }

  /** Members: existing agent ids only (the caller checks them against the agent list). */
  setMembers(id: string, members: string[]): Project {
    const p = this.must(id);
    const next = [...new Set(members)];
    if (next.length > PROJECT_LIMITS.members) throw new ProjectError(400, `A project has at most ${PROJECT_LIMITS.members} members`);
    p.members = next;
    p.updatedAt = nowIso();
    this.touch();
    return structuredClone(p);
  }

  /** `folder` null = the default folder. */
  setFolder(id: string, folder: unknown): Project {
    const p = this.must(id);
    p.folder = folder === null ? this.defaultFolder(id) : validateFolder(folder, { dataDir: this.dataDir, workspaceDir: this.workspaceDir, others: this.list(), selfId: id });
    p.updatedAt = nowIso();
    this.touch();
    return structuredClone(p);
  }

  /** The project a run of `agentId` may use: it exists, is active, and the agent is a member. Anything else: undefined. */
  forRun(projectId: string | undefined, agentId: string): Project | undefined {
    if (!projectId) return undefined;
    const p = this.projects.get(projectId);
    return p && p.status === 'active' && p.members.includes(agentId) ? structuredClone(p) : undefined;
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) this.persist();
    await this.writing;
  }

  private must(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw new ProjectError(404, `Unknown project "${id}"`);
    return p;
  }

  private touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private persist(): void {
    this.dirty = false;
    const projects = [...this.projects.values()].map((p) => ({ ...(this.extras.get(p.id) ?? {}), ...p }));
    const json = JSON.stringify({ ...this.topExtra, version: 1, projects });
    this.writing = this.writing.then(async () => {
      const { writeFile, rename, unlink, mkdir } = await import('node:fs/promises');
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, json, 'utf8');
      try { await rename(tmp, this.file); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EEXIST') { await unlink(this.file).catch(() => undefined); await rename(tmp, this.file); } else throw e;
      }
    }).catch(() => { /* best effort */ });
  }
}

