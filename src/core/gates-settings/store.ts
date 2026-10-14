/**
 * The owner's gate presets: <dataDir>/gates/app.json and <dataDir>/gates/<projectId>.json (spec section 4.1).
 * Same rules as the away store: the core keeps the settings in memory and the files are persistence, read at start and on
 * an explicit reload only, so a shell edit does nothing until the owner reloads from the Gates page. The folder is a
 * protected path for the file tools. A file that is not valid reads as Ask (0.3.0 behavior), is renamed aside, and is
 * listed as unreadable so the page can say so. Writes are debounced, tmp + rename.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATES, isPreset } from '../../shared/gates-registry.js';
import type { GateSettings, GateValue, Preset } from '../../shared/gates-registry.js';
import { PROJECT_ID_RE } from '../../shared/projects.js';

export class GatesError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'GatesError'; }
}

const MAX_BYTES = 64 * 1024;
const DEBOUNCE_MS = 400;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PERMISSION_IDS = new Set<string>(GATES.filter((g) => g.family === 'permission').map((g) => g.id));
const blank = (): GateSettings => ({ version: 1 });
/** What a damaged or unreadable file reads as (spec 4.1). A missing file is blank, not this. */
const damaged = (): GateSettings => ({ version: 1, preset: 'ask' });
/** The default when the caller names no presets: only Ask until a later part widens it. */
const ASK_ONLY: readonly Preset[] = ['ask'];

export class GatesStore {
  readonly folder: string;
  private appS: GateSettings = blank();
  private projects = new Map<string, GateSettings>();
  private unreadable = new Set<string>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly allowed: readonly Preset[];

  constructor(dir: string, opts: { allowed?: readonly Preset[] } = {}) {
    this.folder = dir;
    this.allowed = opts.allowed ?? ASK_ONLY;
    this.reload();
  }

  app(): GateSettings { return { ...this.appS }; }
  project(id: string): GateSettings { return { ...(this.projects.get(id) ?? blank()) }; }

  view(ids: string[]): { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[] } {
    return { app: this.app(), projects: Object.fromEntries(ids.map((id) => [id, this.project(id)])), unreadable: [...this.unreadable] };
  }

  patchApp(body: Record<string, unknown>): GateSettings {
    this.appS = this.merge(this.appS, body, true);
    this.unreadable.delete('app');
    this.mark('app');
    return this.app();
  }

  patchProject(id: string, body: Record<string, unknown>): GateSettings {
    if (!PROJECT_ID_RE.test(id)) throw new GatesError(400, 'That is not a project id.');
    this.projects.set(id, this.merge(this.project(id), body, false));
    this.unreadable.delete(id);
    this.mark(id);
    return this.project(id);
  }

  prune(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const id of [...this.projects.keys()]) if (!live.has(id)) { this.projects.delete(id); this.mark(id); }
  }

  /** Read both kinds of file again (the owner pressed Reload on the Gates page, or the core started). */
  reload(): void {
    // unsaved changes are dropped: the disk is the truth again, and a later flush must not write stale state over it
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.dirty.clear();
    this.unreadable.clear();
    this.projects.clear();
    this.appS = this.readOne('app') ?? blank();
    if (!existsSync(this.folder)) return;
    for (const n of readdirSync(this.folder)) {
      const m = /^(.+)\.json$/.exec(n);
      if (!m || !PROJECT_ID_RE.test(m[1]!)) continue;
      const s = this.readOne(m[1]!);
      if (s) this.projects.set(m[1]!, s);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.writeDirty();
  }

  private merge(cur: GateSettings, body: Record<string, unknown>, isApp: boolean): GateSettings {
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'preset' && k !== 'limit' && k !== 'overrides' && !(isApp && k === 'shellFloorOff'))) throw new GatesError(400, 'Only preset, limit and overrides can be changed here.');
    const out: GateSettings = { ...cur, version: 1 };
    if ('limit' in body) {
      if (isApp) throw new GatesError(400, 'The limit is set per project.');
      if (typeof body.limit !== 'boolean') throw new GatesError(400, 'limit must be true or false.');
      out.limit = body.limit;
    }
    if ('preset' in body) {
      if (body.preset === null) delete out.preset;
      else if (!isPreset(body.preset)) throw new GatesError(400, 'That is not a preset. Use ask, accept-edits, smart or bypass.');
      else if (!this.allowed.includes(body.preset)) throw new GatesError(400, `The ${body.preset} preset is not available yet.`);
      else out.preset = body.preset;
    }
    if ('overrides' in body) {
      if (!isObj(body.overrides) || Object.keys(body.overrides).length > 0) throw new GatesError(400, 'Per-gate overrides are not available yet.');
    }
    if ('shellFloorOff' in body) throw new GatesError(400, 'The shell floor switch is not available yet.');
    return out;
  }

  private readOne(name: string): GateSettings | undefined {
    const file = join(this.folder, `${name}.json`);
    if (!existsSync(file)) return undefined;
    try {
      if (statSync(file).size > MAX_BYTES) throw new Error('too big');
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(raw) || raw.version !== 1) throw new Error('shape');
      const out: GateSettings = { version: 1 };
      if (raw.limit !== undefined) { if (typeof raw.limit !== 'boolean') throw new Error('limit'); out.limit = raw.limit; }
      if (raw.preset !== undefined) {
        if (!isPreset(raw.preset) || !this.allowed.includes(raw.preset)) throw new Error('preset');
        out.preset = raw.preset;
      }
      if (raw.overrides !== undefined) {
        if (!isObj(raw.overrides)) throw new Error('overrides');
        const ov: Record<string, GateValue> = {};
        for (const [k, v] of Object.entries(raw.overrides)) if (PERMISSION_IDS.has(k) && typeof v === 'boolean') ov[k] = v;
        if (Object.keys(ov).length) throw new Error('overrides not available yet');
      }
      return out;
    } catch {
      this.unreadable.add(name);
      try { renameSync(file, `${file}.bad-${Date.now()}`); } catch { /* left in place; still read as Ask */ }
      return damaged();
    }
  }

  private mark(name: string): void {
    this.dirty.add(name);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.writeDirty(); }, DEBOUNCE_MS);
      this.timer.unref?.();
    }
  }

  /** Never throws: a name leaves `dirty` only after its write succeeded, so a failed one is retried on the next flush. */
  private writeDirty(): void {
    for (const name of [...this.dirty]) {
      try {
        this.writeOne(name);
        this.dirty.delete(name);
      } catch { /* best effort: the settings stay in memory and the write is retried later */ }
    }
  }

  private writeOne(name: string): void {
    const file = join(this.folder, `${name}.json`);
    const s = name === 'app' ? this.appS : this.projects.get(name);
    if (!s) { rmSync(file, { force: true }); return; }
    mkdirSync(this.folder, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    try { renameSync(tmp, file); } catch (e) {
      // Windows: rename onto an existing file can fail with EPERM or EEXIST; remove the target and try once more
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw e;
      rmSync(file, { force: true });
      renameSync(tmp, file);
    }
  }
}
