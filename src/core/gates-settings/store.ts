/**
 * The owner's gate presets: <dataDir>/gates/app.json and <dataDir>/gates/<projectId>.json (spec section 4.1).
 * Same rules as the away store: the core keeps the settings in memory and the files are persistence, read at start and on
 * an explicit reload only, so a shell edit does nothing until the owner reloads from the Gates page. The folder is a
 * protected path for the file tools. A file that is not valid reads as Ask (0.3.0 behavior), is renamed aside, and is
 * listed as unreadable so the page can say so. Writes are debounced, tmp + rename.
 *
 * Signing (spec 4.1): with a signer every file is written as `{ ...settings, sig }`. A file that is looser than blank (a looser
 * preset, limit off, a gate turned off or capped higher, an approved site or kept variable) is applied only when its signature
 * verifies. Any other file needs no signature, so files from before signing stay valid. A looser file whose signature is missing or
 * wrong is not applied and is not renamed: the setting reads as Ask and its name is listed in `changedOutside()` until the owner
 * chooses Accept (re-sign and apply what is on disk) or Keep mine (write what the core holds back, signed). With no signer (no
 * keystore key) nothing looser can be stored at all, so only Ask is possible.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATES, gateValue, isPreset } from '../../shared/gates-registry.js';
import type { GateSettings, GateValue, Preset } from '../../shared/gates-registry.js';
import { PROJECT_ID_RE } from '../../shared/projects.js';
import { canonicalize } from './sign.js';
import type { Signer } from './sign.js';

export class GatesError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'GatesError'; }
}

const MAX_BYTES = 64 * 1024;
const DEBOUNCE_MS = 400;
const MAX_HOSTS = 200;
const MAX_ENV_KEEP = 50;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PERMISSION_IDS = new Set<string>(GATES.filter((g) => g.family === 'permission').map((g) => g.id));
const RANK: Record<Preset, number> = { ask: 0, 'accept-edits': 1, smart: 2, bypass: 3 };
/** "Per agent" (no preset) is the 0.3.0 behavior, which ranks the same as Ask for this comparison. */
const rank = (p: Preset | undefined): number => (p ? RANK[p] : 0);
const KEY_MESSAGE = 'Legion needs its keystore key to sign gate settings, so only Ask can be set here. Connect once, or use the Legion app on a computer with a keystore.';
const blank = (): GateSettings => ({ version: 1 });
/** What a damaged or unreadable file reads as (spec 4.1). A missing file is blank, not this. */
const damaged = (): GateSettings => ({ version: 1, preset: 'ask' });
/** The default when the caller names no presets: only Ask until the caller widens it. */
const ASK_ONLY: readonly Preset[] = ['ask'];

/** Is `after` looser than `before` for one gate? A gate going off, a bigger limit, or a limited gate going unlimited. */
function valueLooser(before: GateValue, after: GateValue): boolean {
  if (after === false) return before !== false;
  if (typeof after === 'object') return typeof before === 'object' && after.limit > before.limit;
  return typeof before === 'object';
}

function parseOverrides(v: unknown, strict: boolean): Record<string, GateValue> {
  if (!isObj(v)) throw new GatesError(400, 'overrides must be an object of gate ids.');
  const ov: Record<string, GateValue> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!PERMISSION_IDS.has(k)) {
      if (strict) throw new GatesError(400, `"${k.slice(0, 40)}" is not a gate you can change.`);
      continue; // a file written by a newer Legion may name a gate this one does not know: it is left out
    }
    if (typeof x === 'boolean') ov[k] = x;
    else if (isObj(x) && x.on === true && typeof x.limit === 'number' && Number.isInteger(x.limit) && x.limit >= 1 && x.limit <= 100 && Object.keys(x).length === 2) ov[k] = { on: true, limit: x.limit };
    else throw new GatesError(400, `The value for "${k}" must be on, off, or on with a limit from 1 to 100.`);
  }
  return ov;
}

function parseHosts(v: unknown): string[] {
  if (!Array.isArray(v)) throw new GatesError(400, 'allowedHosts must be a list of site names.');
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') throw new GatesError(400, 'A site name must be text.');
    const h = x.trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_RE.test(h) || h.includes('..')) throw new GatesError(400, `"${x.slice(0, 60)}" is not a site name. Use the name only, like docs.python.org.`);
    if (!out.includes(h)) out.push(h);
  }
  if (out.length > MAX_HOSTS) throw new GatesError(400, `At most ${MAX_HOSTS} approved sites.`);
  return out;
}

function parseEnvKeep(v: unknown): string[] {
  if (!Array.isArray(v)) throw new GatesError(400, 'envKeep must be a list of variable names.');
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !ENV_RE.test(x)) throw new GatesError(400, `"${String(x).slice(0, 60)}" is not a variable name. Use letters, digits and _, with a * only at the end.`);
    if (!out.includes(x)) out.push(x);
  }
  if (out.length > MAX_ENV_KEEP) throw new GatesError(400, `At most ${MAX_ENV_KEEP} kept variables.`);
  return out;
}

/**
 * Is `next` looser than `before`? `appCtx` is the app settings a project is judged under. Compared: the preset rank, the limit,
 * what every permission gate would be, and any approved site or kept variable that is new.
 */
function looserThan(before: GateSettings, next: GateSettings, isApp: boolean, appCtx: GateSettings): boolean {
  if (rank(next.preset) > rank(before.preset)) return true;
  if (next.limit === false && before.limit !== false) return true;
  const ctxOf = (x: GateSettings) => (isApp ? { app: x } : { project: x, app: appCtx });
  for (const id of PERMISSION_IDS) if (valueLooser(gateValue(id, ctxOf(before)), gateValue(id, ctxOf(next)))) return true;
  const added = (a: string[] | undefined, b: string[] | undefined): boolean => (b ?? []).some((x) => !(a ?? []).includes(x));
  return added(before.allowedHosts, next.allowedHosts) || added(before.envKeep, next.envKeep);
}

export class GatesStore {
  readonly folder: string;
  private appS: GateSettings = blank();
  private projects = new Map<string, GateSettings>();
  private unreadable = new Set<string>();
  /** Names whose file is looser than blank and did not verify: not applied, the file is left as it is. */
  private outside = new Set<string>();
  /** What those files hold, cleaned: what Accept applies. */
  private pending = new Map<string, GateSettings>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly allowed: readonly Preset[];
  private readonly signer: Signer | undefined;

  constructor(dir: string, opts: { allowed?: readonly Preset[]; signer?: Signer } = {}) {
    this.folder = dir;
    this.allowed = opts.allowed ?? ASK_ONLY;
    this.signer = opts.signer;
    this.reload();
  }

  /** Whether this core holds a key to sign with. Without one only Ask can be stored. */
  canSign(): boolean { return this.signer !== undefined; }
  /** The names (`app` or a project id) whose file changed outside Legion and wait for Accept or Keep mine. */
  changedOutside(): string[] { return [...this.outside]; }

  app(): GateSettings { return { ...this.appS }; }
  project(id: string): GateSettings { return { ...(this.projects.get(id) ?? blank()) }; }

  view(ids: string[]): { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[]; changedOutside: string[]; canSign: boolean } {
    return { app: this.app(), projects: Object.fromEntries(ids.map((id) => [id, this.project(id)])), unreadable: [...this.unreadable], changedOutside: this.changedOutside(), canSign: this.canSign() };
  }

  /**
   * Would this change make anything looser than it is now? The routes ask this to decide whether the app's native confirm is
   * needed. A body that is not valid counts as a loosening (fail closed); the patch itself then says what is wrong.
   */
  isLoosening(name: string, body: Record<string, unknown>): boolean {
    const isApp = name === 'app';
    if (!isApp && !PROJECT_ID_RE.test(name)) return true;
    try {
      const cur = isApp ? this.appS : this.project(name);
      return looserThan(cur, this.build(cur, body, isApp), isApp, this.appS);
    } catch { return true; }
  }

  patchApp(body: Record<string, unknown>): GateSettings {
    this.appS = this.merge(this.appS, body, true);
    this.settle('app');
    return this.app();
  }

  patchProject(id: string, body: Record<string, unknown>): GateSettings {
    if (!PROJECT_ID_RE.test(id)) throw new GatesError(400, 'That is not a project id.');
    this.projects.set(id, this.merge(this.project(id), body, false));
    this.settle(id);
    return this.project(id);
  }

  /** The owner chose to apply what is on disk. It is re-signed, written, and applies from now on. */
  accept(name: string): GateSettings {
    const p = this.pending.get(name);
    if (!this.outside.has(name) || !p) throw new GatesError(404, 'That file has not changed outside Legion.');
    if (!this.signer) throw new GatesError(400, KEY_MESSAGE);
    if (name === 'app') this.appS = { ...p }; else this.projects.set(name, { ...p });
    this.settle(name);
    return name === 'app' ? this.app() : this.project(name);
  }

  /** The owner chose to keep what the core holds (Ask, until a change is saved): the file is rewritten from memory, signed. */
  keepMine(name: string): void {
    if (!this.outside.has(name)) throw new GatesError(404, 'That file has not changed outside Legion.');
    this.settle(name);
  }

  prune(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const id of [...this.projects.keys()]) {
      if (live.has(id)) continue;
      this.projects.delete(id); this.outside.delete(id); this.pending.delete(id); this.mark(id);
    }
  }

  /** Read both kinds of file again (the owner pressed Reload on the Gates page, or the core started). */
  reload(): void {
    // unsaved changes are dropped: the disk is the truth again, and a later flush must not write stale state over it
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.dirty.clear();
    this.unreadable.clear();
    this.outside.clear();
    this.pending.clear();
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

  /** An owner's save: the file is theirs now, so it is written from memory and the damaged and changed-outside marks go. */
  private settle(name: string): void {
    this.unreadable.delete(name);
    this.outside.delete(name);
    this.pending.delete(name);
    this.mark(name);
  }

  private merge(cur: GateSettings, body: Record<string, unknown>, isApp: boolean): GateSettings {
    const out = this.build(cur, body, isApp);
    if (!this.signer && looserThan(cur, out, isApp, this.appS)) throw new GatesError(400, KEY_MESSAGE);
    return out;
  }

  /** Validates a patch and returns the settings it would give. Throws a 400 for anything wrong; never looks at the key. */
  private build(cur: GateSettings, body: Record<string, unknown>, isApp: boolean): GateSettings {
    if ('shellFloorOff' in body) throw new GatesError(400, "Legion's shell safety floor has no switch.");
    if (Object.keys(body).some((k) => k !== 'preset' && k !== 'limit' && k !== 'overrides' && k !== 'allowedHosts' && k !== 'envKeep')) {
      throw new GatesError(400, 'Only preset, limit, overrides, allowedHosts and envKeep can be changed here.');
    }
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
      // the whole list: a gate left out goes back to what the preset says
      const ov = parseOverrides(body.overrides, true);
      if (Object.keys(ov).length) out.overrides = ov as GateSettings['overrides']; else delete out.overrides;
    }
    if ('allowedHosts' in body) {
      if (!isApp) throw new GatesError(400, 'Approved sites are set for the whole app, not per project.');
      const l = parseHosts(body.allowedHosts);
      if (l.length) out.allowedHosts = l; else delete out.allowedHosts;
    }
    if ('envKeep' in body) {
      if (!isApp) throw new GatesError(400, 'Kept variables are set for the whole app, not per project.');
      const l = parseEnvKeep(body.envKeep);
      if (l.length) out.envKeep = l; else delete out.envKeep;
    }
    return out;
  }

  private readOne(name: string): GateSettings | undefined {
    const file = join(this.folder, `${name}.json`);
    if (!existsSync(file)) return undefined;
    const isApp = name === 'app';
    try {
      if (statSync(file).size > MAX_BYTES) throw new Error('too big');
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(raw) || raw.version !== 1) throw new Error('shape');
      const { sig, ...unsigned } = raw;
      const out: GateSettings = { version: 1 };
      if (raw.limit !== undefined) { if (typeof raw.limit !== 'boolean') throw new Error('limit'); out.limit = raw.limit; }
      if (raw.preset !== undefined) {
        if (!isPreset(raw.preset) || !this.allowed.includes(raw.preset)) throw new Error('preset');
        out.preset = raw.preset;
      }
      if (raw.overrides !== undefined) {
        const ov = parseOverrides(raw.overrides, false);
        if (Object.keys(ov).length) out.overrides = ov as GateSettings['overrides'];
      }
      if (raw.allowedHosts !== undefined) {
        if (!isApp) throw new Error('allowedHosts');
        const l = parseHosts(raw.allowedHosts); if (l.length) out.allowedHosts = l;
      }
      if (raw.envKeep !== undefined) {
        if (!isApp) throw new Error('envKeep');
        const l = parseEnvKeep(raw.envKeep); if (l.length) out.envKeep = l;
      }
      // The signature covers the file as it was written (every key but `sig`), so an old file with a field this version drops still verifies.
      const verified = this.signer !== undefined && typeof sig === 'string' && this.signer.verify(name, canonicalize(unsigned as unknown as GateSettings), sig);
      if (!verified && looserThan(blank(), out, isApp, blank())) {
        // looser than blank and not proven to be ours: not applied, left on disk for the owner to accept or keep theirs
        this.outside.add(name);
        this.pending.set(name, out);
        return damaged();
      }
      // a field this version no longer has (the shell floor switch) is dropped here and gone from the file after this rewrite;
      // a file that needs no signature gets one when a key exists
      if ('shellFloorOff' in raw || (this.signer !== undefined && !verified)) this.mark(name);
      return out;
    } catch {
      this.unreadable.add(name);
      let setAside = false;
      try { renameSync(file, `${file}.bad-${Date.now()}`); setAside = true; } catch { /* left in place; still read as Ask */ }
      // Write the Ask record back only once the damaged original is safely aside, so the write never removes it.
      // A restart then reads Ask from disk instead of a blank file (which would lose the cap).
      if (setAside) this.mark(name);
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
    // without a key nothing looser than blank may be written: it could never be verified again
    if (!this.signer && looserThan(blank(), s, name === 'app', blank())) return;
    mkdirSync(this.folder, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.signer ? { ...s, sig: this.signer.sign(name, canonicalize(s)) } : s, null, 2));
    try { renameSync(tmp, file); } catch (e) {
      // Windows: rename onto an existing file can fail with EPERM or EEXIST; remove the target and try once more
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw e;
      rmSync(file, { force: true });
      renameSync(tmp, file);
    }
  }
}
