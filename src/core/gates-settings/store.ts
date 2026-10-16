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
 *
 * Folder-level attacks (fix round 2): the signed app file lists every project file with its counter, and is the thing that proves the
 * folder is whole. Electron says whether the key is `new` (an empty data folder), `old` (the key file was there) or `lost` (a used data
 * folder with no key file). With an old or lost key, an app file that is missing or does not verify means the list is gone: every project
 * reads Ask, every name is listed, and only Keep mine on `app` (which writes Ask everywhere) or an owner's per-project choice ends it.
 * An app file whose counter is below a project file's was replayed and is treated the same way. A project file counts as genuine only if
 * the verified list names it. Nothing here deletes a cap file or a list entry for a project missing from projects.json.
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
export type GatesKeyState = 'new' | 'old' | 'lost' | 'unreadable';
const UNREADABLE_MESSAGE = "Legion's gate key exists but could not be opened (the keystore may be locked or damaged). Every project is Ask until it opens again.";
const LOST_MESSAGE = "Legion's gate settings are missing or were changed. Every project is Ask until you choose. Choose Keep mine to set every project to Ask, then change what you want.";
const KEY_MESSAGE = "Legion needs a key from your computer's keystore to sign gate settings, and none is available, so only Ask can be set here.";
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

function parseFiles(v: unknown): Record<string, number> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new Error('files');
  const out: Record<string, number> = {};
  for (const [k, g] of Object.entries(v)) {
    if (!PROJECT_ID_RE.test(k) || typeof g !== 'number' || !Number.isInteger(g) || g < 0) throw new Error('files');
    out[k] = g;
  }
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
  // No cap at all (a project with no preset, or with its limit off) is looser than any cap, Bypass included.
  const cap = (x: GateSettings): number => (x.preset && x.limit !== false ? RANK[x.preset] : 4);
  if (!isApp && cap(next) > cap(before)) return true;
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
  /** The newest counter written per project file, as listed in the signed app file. A file below its counter is a replay. */
  private listGens = new Map<string, number>();
  /** Project ids that have a file: the verified list, or the hint of an app file that did not verify (a hint can only add Ask). */
  private listIds = new Set<string>();
  /** What the next app file lists: every project file this core wrote or read as genuine. */
  private fileGens = new Map<string, number>();
  /** The list that proves the folder is whole is gone (missing or unverified app file with an old or lost key, or a replayed one). */
  private lost = false;
  private appVerified = false;
  private appGen = 0;
  private maxProjGen = 0;
  private seq = 0;
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly allowed: readonly Preset[];
  private readonly signer: Signer | undefined;
  private readonly keyState: GatesKeyState;

  constructor(dir: string, opts: { allowed?: readonly Preset[]; signer?: Signer; keyState?: GatesKeyState } = {}) {
    this.folder = dir;
    this.allowed = opts.allowed ?? ASK_ONLY;
    this.signer = opts.signer;
    this.keyState = opts.keyState ?? 'new';
    this.reload();
    // A new install writes its (blank) signed app file at once, so a missing app file later means it was deleted, not never made.
    if (this.signer && opts.keyState === 'new' && !existsSync(join(this.folder, 'app.json'))) this.mark('app');
  }

  /** Whether this core holds a key to sign with. Without one only Ask can be stored. */
  canSign(): boolean { return this.signer !== undefined; }
  /** The names (`app` or a project id) whose file changed outside Legion and wait for Accept or Keep mine. */
  changedOutside(): string[] { return [...this.outside]; }

  app(): GateSettings { return { ...this.appS }; }
  project(id: string): GateSettings { return { ...(this.projects.get(id) ?? (this.lost ? damaged() : blank())) }; }

  view(ids: string[]): { app: GateSettings; projects: Record<string, GateSettings>; unreadable: string[]; changedOutside: string[]; canSign: boolean; keyUnreadable: boolean } {
    return { app: this.app(), projects: Object.fromEntries(ids.map((id) => [id, this.project(id)])), unreadable: [...this.unreadable], changedOutside: this.lost ? [...new Set(['app', ...ids, ...this.outside])] : this.changedOutside(), canSign: this.canSign(), keyUnreadable: this.keyState === 'unreadable' };
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
    if (this.lost) throw new GatesError(409, this.keyState === 'unreadable' ? UNREADABLE_MESSAGE : LOST_MESSAGE);
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
    if (!this.outside.has(name) && !this.lost) throw new GatesError(404, 'That file has not changed outside Legion.');
    if (!p) throw new GatesError(404, 'There is no file to apply. Choose Keep mine.');
    if (!this.signer) throw new GatesError(400, KEY_MESSAGE);
    if (name === 'app' && this.lost) throw new GatesError(400, LOST_MESSAGE);
    if (name === 'app') this.appS = { ...p }; else this.projects.set(name, { ...p });
    this.settle(name);
    return name === 'app' ? this.app() : this.project(name);
  }

  /** The owner chose to keep what the core holds (Ask, until a change is saved): the file is rewritten from memory, signed. */
  keepMine(name: string, ids: readonly string[] = []): void {
    if (!this.outside.has(name) && !this.lost) throw new GatesError(404, 'That file has not changed outside Legion.');
    if (this.lost && name === 'app') {
      // Ask everywhere: every project (those with a file, those named by `ids`) gets an Ask file, signed. Nothing from disk is imported.
      for (const id of new Set([...this.projects.keys(), ...ids])) { this.projects.set(id, damaged()); this.settle(id); }
      this.appS = damaged();
      if (this.keyState !== 'unreadable') this.lost = false; // an unopenable key cannot verify anything: Ask stays
    } else if (this.lost) this.projects.set(name, damaged());
    this.settle(name);
  }

  /** Drops the caps of projects that no longer exist. Only for an owner's project delete, never called at start: a damaged or edited projects.json must not remove a cap. */
  prune(liveIds: string[]): void {
    const live = new Set(liveIds);
    for (const id of [...this.projects.keys()]) {
      if (live.has(id)) continue;
      this.projects.delete(id); this.outside.delete(id); this.pending.delete(id); this.fileGens.delete(id); this.mark(id);
    }
  }

  /** Read both kinds of file again (the owner pressed Reload on the Gates page, or the core started). */
  reload(): void {
    // Unsaved changes are written first: a change still waiting for its write (a tightening, say) must not be undone by an older file.
    // If one cannot be written, nothing is re-read, so memory keeps what the owner chose.
    this.writeDirty();
    if (this.dirty.size > 0) throw new GatesError(409, 'Legion could not save your last change, and Reload would undo it. Try again in a moment.');
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.lost = false;
    this.loadAll();
    // an app file older than a project file (a replay): the list is not to be trusted, so read it all again as lost
    if (this.signer && this.appVerified && this.appGen < this.maxProjGen) { this.lost = true; this.loadAll(); }
    // A project the app file lists whose file is gone reads Ask and is listed: deleting a file must not remove its cap.
    for (const id of this.listIds) {
      if (this.projects.has(id)) continue;
      this.projects.set(id, damaged());
      this.outside.add(id);
    }
  }

  private loadAll(): void {
    this.listGens.clear(); this.listIds.clear(); this.fileGens.clear();
    this.unreadable.clear();
    // a key file that exists but does not open: nothing can be verified, so every project reads Ask and is listed
    if (this.keyState === 'unreadable') this.lost = true;
    this.outside.clear();
    this.pending.clear();
    this.projects.clear();
    this.appVerified = false; this.appGen = 0; this.maxProjGen = 0;
    if (this.signer && this.keyState !== 'new' && !existsSync(join(this.folder, 'app.json'))) this.lost = true;
    this.appS = this.readOne('app') ?? blank();
    if (this.lost) { this.outside.add('app'); if (!this.pending.has('app')) this.appS = damaged(); }
    for (const n of existsSync(this.folder) ? readdirSync(this.folder) : []) {
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
      if (isApp) throw new GatesError(400, 'Gates are set per project.');
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
      // an editor may save a byte order mark; it is not part of the JSON
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (!isObj(raw) || raw.version !== 1) throw new Error('shape');
      const { sig, ...unsigned } = raw;
      const out: GateSettings = { version: 1 };
      if (raw.limit !== undefined) { if (typeof raw.limit !== 'boolean') throw new Error('limit'); out.limit = raw.limit; }
      if (raw.preset !== undefined) {
        if (!isPreset(raw.preset) || !this.allowed.includes(raw.preset)) throw new Error('preset');
        out.preset = raw.preset;
      }
      if (raw.overrides !== undefined && !isApp) {
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
      const gen = typeof raw.gen === 'number' && Number.isInteger(raw.gen) && raw.gen >= 0 ? raw.gen : 0;
      const files = isApp ? parseFiles(raw.files) : {};
      // The signature covers the file as it was written (every key but `sig`), so an old file with a field this version drops still verifies.
      const verified = this.signer !== undefined && typeof sig === 'string' && this.signer.verify(name, canonicalize(unsigned as unknown as GateSettings), sig);
      if (isApp) {
        for (const id of Object.keys(files)) this.listIds.add(id); // even an unverified list can only add Ask caps
        if (verified) for (const [id, g] of Object.entries(files)) { this.listGens.set(id, g); this.fileGens.set(id, g); }
      }
      if (isApp) {
        this.appVerified = verified; this.appGen = gen;
        if (this.signer && this.keyState !== 'new' && !verified) this.lost = true;
      } else if (verified) this.maxProjGen = Math.max(this.maxProjGen, gen);
      if (verified) this.seq = Math.max(this.seq, gen, ...Object.values(files));
      const listed = this.listGens.get(name);
      let genuine: boolean;
      // no key: only what is no looser than blank, and a listed project file must still carry its Ask cap
      if (this.signer === undefined) genuine = !looserThan(blank(), out, isApp, blank()) && (isApp || !this.listIds.has(name) || (out.preset === 'ask' && out.limit !== false));
      else if (verified) genuine = isApp || (listed !== undefined && gen >= listed); // not on the list, or older than the list says: a replay
      else genuine = false;
      if (this.signer !== undefined && !verified) {
        // Unsigned: only an Ask file from before signing (or a blank app file) is taken, and never over a listed project file.
        const plain = !('sig' in raw) && !('gen' in raw) && !('files' in raw) && !looserThan(blank(), out, isApp, blank());
        genuine = plain && (isApp || (out.preset === 'ask' && out.limit !== false && !this.listIds.has(name)));
      }
      // the list is gone: nothing on disk is proven, so every name waits for the owner
      if (this.lost) genuine = false;
      if (!genuine) {
        // not proven to be ours (or no cap): not applied, left on disk for the owner to accept or keep theirs
        this.outside.add(name);
        this.pending.set(name, out);
        return damaged();
      }
      if (verified && !isApp) this.fileGens.set(name, gen);
      // a field this version no longer has (the shell floor switch) is dropped here and gone from the file after this rewrite;
      // an Ask file from before signing gets its signature on the first save
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
    const names = [...this.dirty];
    const projects = names.filter((n) => n !== 'app');
    // the app file lists the project files, so it is written after them (a crash between leaves a file newer than its list, which is fine)
    // a lost list is not rewritten except by the owner's Keep mine on app
    if (this.lost && names.includes('app')) names.splice(names.indexOf('app'), 1);
    // while the list is lost the app file is never written, not even for a project write: the next start must still find it missing
    const order = !this.lost && (names.includes('app') || (this.signer !== undefined && projects.length > 0)) ? [...projects, 'app'] : projects;
    for (const name of order) {
      try {
        this.writeOne(name);
        this.dirty.delete(name);
      } catch { /* best effort: the settings stay in memory and the write is retried later */ }
    }
  }

  private writeOne(name: string): void {
    const file = join(this.folder, `${name}.json`);
    const s = name === 'app' ? this.appS : this.projects.get(name);
    if (!s) { rmSync(file, { force: true }); this.fileGens.delete(name); return; }
    // without a key nothing looser than blank may be written: it could never be verified again
    if (!this.signer && looserThan(blank(), s, name === 'app', blank())) return;
    // without a key a signed app file with its list is left as it is: rewriting it would erase the list
    if (!this.signer && name === 'app' && this.listIds.size > 0) return;
    mkdirSync(this.folder, { recursive: true });
    const tmp = `${file}.tmp`;
    // Signed files carry a counter that only goes up; the app file also lists the newest counter of every project file.
    const gen = this.seq + 1;
    const body: GateSettings & { gen?: number; files?: Record<string, number> } = { ...s };
    if (this.signer) { body.gen = gen; if (name === 'app') body.files = Object.fromEntries(this.fileGens); }
    const text = JSON.stringify(this.signer ? { ...body, sig: this.signer.sign(name, canonicalize(body)) } : s, null, 2);
    writeFileSync(tmp, text);
    try { renameSync(tmp, file); } catch (e) {
      // Windows: rename onto an existing file can fail with EPERM or EEXIST; remove the target and try once more
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST') throw e;
      rmSync(file, { force: true });
      renameSync(tmp, file);
    }
    if (this.signer) { this.seq = gen; if (name !== 'app') this.fileGens.set(name, gen); }
  }
}
