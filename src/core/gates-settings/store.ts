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
 * folder is whole. Electron says whether the key is `new` (a first keyed start), `old` (the key file was there) or `lost` (no key file but
 * gates/ holds a signed file). The store checks the `lost` word against the folder: with no signed file in gates/ it is a first keyed start
 * (a 0.3.4 folder), and its unsigned Ask files keep their meaning. With an old or lost key, an app file that is missing or does not verify means the list is gone: every project
 * reads Ask, every name is listed, and only Keep mine on `app` (which writes Ask everywhere) or an owner's per-project choice ends it.
 * An app file whose counter is below a project file's was replayed and is treated the same way. A project file counts as genuine only if
 * the verified list names it. Nothing here deletes a cap file or a list entry for a project missing from projects.json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BYPASS_KEYS_LINE, DENY_LINE, ENV_KEEP_MAX, ENV_KEEP_RE, ENV_NEVER_PASSED, ENV_NEVER_PASSED_PREFIX, GATES, LIMIT_GATE_IDS, NO_SANDBOX_LINE, PROTECTED_FILES_TEXT, TRUSTED_FOLDERS_MAX, TRUSTED_FOLDER_PATH_MAX, gateValue, isPreset } from '../../shared/gates-registry.js';
import type { GateSettings, GateValue, Preset, TrustedFolderRecord } from '../../shared/gates-registry.js';
import { plain, realFolder, sameFolder, scanFolder } from '../folder-trust.js';
import type { FolderScan } from '../folder-trust.js';
import { PROJECT_ID_RE } from '../../shared/projects.js';
import { hasSignedGatesFile, keyUnconfirmed, unconfirmedMarkerPath } from '../../shared/gates-signed.js';
import { canonicalize } from './sign.js';
import type { Signer } from './sign.js';

export class GatesError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'GatesError'; }
}

const MAX_BYTES = 64 * 1024;
const DEBOUNCE_MS = 400;
const MAX_HOSTS = 200;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PERMISSION_IDS = new Set<string>(GATES.filter((g) => g.family === 'permission').map((g) => g.id));
const RANK: Record<Preset, number> = { ask: 0, 'accept-edits': 1, smart: 2, bypass: 3 };
/** "Per agent" (no preset) is the 0.3.0 behavior, which ranks the same as Ask for this comparison. */
const rank = (p: Preset | undefined): number => (p ? RANK[p] : 0);
/** Accept edits and Smart are not ordered: each waves through something the other asks about, so a switch either way is a loosening. */
const unordered = (a: Preset | undefined, b: Preset | undefined): boolean => (a === 'smart' && b === 'accept-edits') || (a === 'accept-edits' && b === 'smart');
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
    else if (isObj(x) && !LIMIT_GATE_IDS.includes(k)) {
      // only the retry and goal gates have a limit; a file from elsewhere that gives another gate one reads as plain "on"
      if (strict) throw new GatesError(400, `"${k}" has no limit. Set it on or off.`);
      ov[k] = x.on === true;
    } else if (isObj(x) && x.on === true && typeof x.limit === 'number' && Number.isInteger(x.limit) && x.limit >= 1 && x.limit <= 100 && Object.keys(x).length === 2) ov[k] = { on: true, limit: x.limit };
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
    if (typeof x !== 'string' || !ENV_KEEP_RE.test(x)) throw new GatesError(400, `"${String(x).slice(0, 60)}" is not a variable name. Use letters, digits and _, with a * only at the end.`);
    if (!out.some((o) => o.toUpperCase() === x.toUpperCase())) out.push(x);
  }
  if (out.length > ENV_KEEP_MAX) throw new GatesError(400, `At most ${ENV_KEEP_MAX} kept variables.`);
  return out;
}

function parseTrusted(v: unknown): TrustedFolderRecord[] {
  if (!Array.isArray(v) || v.length > TRUSTED_FOLDERS_MAX) throw new Error('trustedFolders');
  const out: TrustedFolderRecord[] = [];
  for (const x of v) {
    if (!isObj(x) || Object.keys(x).length !== 2 || typeof x.folder !== 'string' || !x.folder || x.folder.length > TRUSTED_FOLDER_PATH_MAX || typeof x.digest !== 'string' || !/^[0-9a-f]{64}$/.test(x.digest)) throw new Error('trustedFolders');
    if (!out.some((o) => sameFolder(o.folder, x.folder as string))) out.push({ folder: x.folder, digest: x.digest });
  }
  return out;
}

/** The sentences for a folder the owner is about to trust. With `detail`, the folder is scanned now and its exact commands, helpers and variable names follow (never a value). */
function trustLines(e: TrustedFolderRecord, scanner: ((folder: string) => FolderScan) | undefined): string[] {
  const head = `Let ${plain(e.folder, 200)} run its own commands whenever an agent works there. Its settings and skills are trusted only as they are now: any change asks you again.`;
  if (!scanner) return [head];
  const scan = scanner(e.folder);
  if (scan.digest !== e.digest) return [head, 'What the folder holds has changed since this was written, so this record would not match it.'];
  return [head, ...scan.lines, ...(scan.more > 0 ? [`and ${scan.more} more`] : [])];
}

/**
 * Is `next` looser than `before`? `appCtx` is the app settings a project is judged under. Compared: the preset rank, the limit,
 * what every permission gate would be, and any approved site or kept variable that is new.
 */
function looserThan(before: GateSettings, next: GateSettings, isApp: boolean, appCtx: GateSettings): boolean {
  return describeChange(before, next, isApp, appCtx).loosen.length > 0;
}

export const PRESET_NAME: Record<Preset, string> = { ask: 'Ask', 'accept-edits': 'Accept edits', smart: 'Smart', bypass: 'Bypass' };
const PRESET_LOOSEN: Record<Exclude<Preset, 'ask'>, string> = {
  'accept-edits': 'File edits run without asking. Everything else still asks.',
  smart: "Legion decides when to ask. It asks only before an action that reaches the web, sends data out, deletes, spends, can't be undone, or that it can't classify. Everything else runs.",
  bypass: `No permission cards. Agents run commands, change files and write to GitHub without asking. Only a command that changes ${PROTECTED_FILES_TEXT} still asks. ${BYPASS_KEYS_LINE} Everything is logged.`,
};
const PER_AGENT_LINE = "Each agent's own mode applies, Bypass included.";
const LIMIT_OFF_LINE = "Agents with their own mode can go beyond this project's setting.";
const gateDef = (id: string) => GATES.find((g) => g.id === id);

export interface ChangeLines { loosen: string[]; tighten: string[]; /** True when a loosening lets commands run with fewer questions: the dialog then says Legion has no sandbox. */ sandbox: boolean }

/**
 * What a change does, in plain sentences: one for each thing it loosens and each thing it tightens. This is the one place that decides
 * what counts as a loosening: `looserThan` is "has a loosening line", the preview shows these lines, and the app's dialog shows the
 * preview, so a change can never loosen anything the dialog did not say. Compared: the preset, the limit, the cap an agent works under,
 * what every permission gate would be (an override dropped from the list counts), and approved sites and kept variables.
 */
function describeChange(before: GateSettings, next: GateSettings, isApp: boolean, appCtx: GateSettings, scanner?: (folder: string) => FolderScan): ChangeLines {
  const out: ChangeLines = { loosen: [], tighten: [], sandbox: false };
  let presetLoosened = false;
  if (rank(next.preset) > rank(before.preset) || unordered(before.preset, next.preset)) {
    out.loosen.push(PRESET_LOOSEN[next.preset as Exclude<Preset, 'ask'>] ?? DENY_LINE); presetLoosened = true; out.sandbox = true;
  } else if (rank(next.preset) < rank(before.preset)) out.tighten.push(`The preset is now ${next.preset ? PRESET_NAME[next.preset] : 'Per agent'}.`);
  if (next.limit === false && before.limit !== false) { out.loosen.push(LIMIT_OFF_LINE); out.sandbox = true; }
  else if (before.limit === false && next.limit !== false) out.tighten.push("Agents are limited to this project's setting again.");
  // No cap at all (a project with no preset, or with its limit off) is looser than any cap, Bypass included.
  const cap = (x: GateSettings): number => (x.preset && x.limit !== false ? RANK[x.preset] : 4);
  if (!isApp && cap(next) > cap(before) && !presetLoosened && !out.loosen.includes(LIMIT_OFF_LINE)) {
    out.loosen.push(next.preset ? LIMIT_OFF_LINE : PER_AGENT_LINE); out.sandbox = true;
  }
  const capPreset = (x: GateSettings): Preset | undefined => (x.limit !== false ? x.preset : undefined);
  if (!isApp && unordered(capPreset(before), capPreset(next)) && !presetLoosened) { out.loosen.push(LIMIT_OFF_LINE); out.sandbox = true; }
  const ctxOf = (x: GateSettings) => (isApp ? { app: x } : { project: x, app: appCtx });
  // Every gate whose value gets looser has its own line, whether the preset, an override or a dropped override did it. The preset line
  // is a headline; it is never taken as saying what a gate does.
  for (const id of PERMISSION_IDS) {
    const g = gateDef(id); if (!g) continue;
    const was = gateValue(id, ctxOf(before)); const now = gateValue(id, ctxOf(next));
    if (valueLooser(was, now)) {
      if (now === false) out.loosen.push(`${g.label}: off. ${g.ifOff}`);
      else if (typeof now === 'object') out.loosen.push(`${g.label}: the limit goes from ${(was as { limit: number }).limit} to ${now.limit}.`);
      else out.loosen.push(`${g.label}: the limit is removed. ${g.ifOff}`);
      if (id === 'tool-cards' || id === 'module-cards') out.sandbox = true;
    } else if (valueLooser(now, was)) out.tighten.push(`${g.label}: on again.`);
  }
  const added = (a: string[] | undefined, b: string[] | undefined): string[] => (b ?? []).filter((x) => !(a ?? []).includes(x));
  // kept variables first: they can hold a secret, and a long list of sites is cut short in the dialog
  for (const v of added(before.envKeep, next.envKeep)) out.loosen.push(`Commands keep the variable ${v}, which can hold a secret. In API key or cloud mode, Claude's own scrub may still hide it from Claude's commands.`);
  for (const h of added(before.allowedHosts, next.allowedHosts)) out.loosen.push(`Agents may read ${h} without asking.`);
  for (const h of added(next.allowedHosts, before.allowedHosts)) out.tighten.push(`Agents ask before reading ${h} again.`);
  for (const v of added(next.envKeep, before.envKeep)) out.tighten.push(`The variable ${v} is hidden from commands again.`);
  // a trusted folder is new when its folder and its fingerprint pair is not on the old list (new content for a known folder counts)
  const hasRec = (list: TrustedFolderRecord[] | undefined, e: TrustedFolderRecord): boolean => (list ?? []).some((x) => sameFolder(x.folder, e.folder) && x.digest === e.digest);
  for (const e of next.trustedFolders ?? []) if (!hasRec(before.trustedFolders, e)) { out.loosen.push(...trustLines(e, scanner)); out.sandbox = true; }
  for (const e of before.trustedFolders ?? []) if (!(next.trustedFolders ?? []).some((x) => sameFolder(x.folder, e.folder))) out.tighten.push(`Agents working in ${plain(e.folder, 200)} no longer run its own commands without your say.`);
  return out;
}

export interface GatePreview { lines: string[]; /** The loosening lines only: what the app's dialog shows. */ loosening: string[]; loosens: boolean; /** sha256 of the name, the settings before, the settings the change would give and, for a project, the app settings. */ digest: string }

/** Binds the name, where the change starts, where it ends and, for a project, the app settings it is judged under. */
const digestOf = (name: string, before: GateSettings, next: GateSettings, appCtx: GateSettings | undefined): string =>
  createHash('sha256').update(`${name}\n${canonicalize(before)}\n${canonicalize(next)}\n${appCtx ? canonicalize(appCtx) : '-'}`).digest('hex');

function previewOf(name: string, before: GateSettings, next: GateSettings, isApp: boolean, appCtx: GateSettings, always: boolean, scanner: (folder: string) => FolderScan): GatePreview {
  const d = describeChange(before, next, isApp, appCtx, scanner);
  const loosening = d.loosen.length ? [...d.loosen, DENY_LINE, ...(d.sandbox ? [NO_SANDBOX_LINE] : [])] : [];
  return { lines: [...loosening, ...d.tighten], loosening, loosens: always || d.loosen.length > 0, digest: digestOf(name, before, next, isApp ? undefined : appCtx) };
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

  /** Whether `.mcp.json` servers count as executable content (the owner's "Also load MCP servers" switch, read at each scan). */
  private readonly mcpOn: () => boolean;

  constructor(dir: string, opts: { allowed?: readonly Preset[]; signer?: Signer; keyState?: GatesKeyState; inheritMcp?: () => boolean } = {}) {
    this.folder = dir;
    this.mcpOn = opts.inheritMcp ?? (() => false);
    this.allowed = opts.allowed ?? ASK_ONLY;
    this.signer = opts.signer;
    // `lost` means "gates/ holds a signed file and the key file is gone". Electron's word is only a hint: a data folder from 0.3.4 or 0.3.0
    // has no gates-key.bin and no signed gates file, and that is a first keyed start (its unsigned Ask files keep their old meaning).
    const hint = opts.keyState ?? 'new';
    // The same holds for `old` when Electron made the key file but no core signed anything yet (the marker it wrote with the key, no signed file).
    this.keyState = (hint === 'lost' && !hasSignedGatesFile(this.folder)) || (hint === 'old' && keyUnconfirmed(dirname(this.folder))) ? 'new' : hint;
    this.reload();
    // A new install writes its (blank) signed app file at once, so a missing app file later means it was deleted, not never made.
    if (this.signer && this.keyState === 'new' && !existsSync(join(this.folder, 'app.json'))) this.mark('app');
    // The first keyed start signs what it found NOW, not 400 ms later: the key file already exists, so a core that quits before the timer would
    // leave the next start (key state `old`) a folder with no signed file, which reads as lost. A failed write stays queued and is retried.
    if (this.signer && this.keyState === 'new') this.writeDirty();
  }

  /** A folder scanned the way a run scans it (the fingerprint the engine will compute), so what the owner trusts is what a run will find. */
  scan(folder: string): FolderScan { return scanFolder(folder, { mcp: this.mcpOn() }); }

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

  /**
   * What a patch would do, without doing it: the sentences for each loosening and tightening, whether it loosens, and the digest of the
   * settings it would give. The app shows the loosening lines in its dialog and sends the digest back with the change.
   */
  preview(name: string, body: Record<string, unknown>): GatePreview {
    const isApp = name === 'app';
    if (!isApp && !PROJECT_ID_RE.test(name)) throw new GatesError(400, 'That is not a project id.');
    if (isApp && this.lost) throw new GatesError(409, this.keyState === 'unreadable' ? UNREADABLE_MESSAGE : LOST_MESSAGE);
    const cur = isApp ? this.appS : this.project(name);
    return previewOf(name, cur, this.build(cur, body, isApp), isApp, this.appS, false, (f) => this.scan(f));
  }

  /** What Accept would apply: the file's settings against what the core holds now. Accept always needs the app's confirm. */
  previewAccept(name: string): GatePreview {
    const p = this.acceptable(name);
    const isApp = name === 'app';
    return previewOf(name, isApp ? this.appS : this.project(name), p, isApp, this.appS, true, (f) => this.scan(f));
  }

  /** The pending file content for a name Accept may apply, or the error Accept would give. */
  private acceptable(name: string): GateSettings {
    const p = this.pending.get(name);
    if (!this.outside.has(name) && !this.lost) throw new GatesError(404, 'That file has not changed outside Legion.');
    if (!p) throw new GatesError(404, 'There is no file to apply. Choose Keep mine.');
    if (!this.signer) throw new GatesError(400, KEY_MESSAGE);
    if (name === 'app' && this.lost) throw new GatesError(400, LOST_MESSAGE);
    return p;
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
    const p = this.acceptable(name);
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
    if (Object.keys(body).some((k) => k !== 'preset' && k !== 'limit' && k !== 'overrides' && k !== 'allowedHosts' && k !== 'envKeep' && k !== 'trustFolder' && k !== 'untrustFolder' && k !== 'firstRunChoice' && k !== 'noticeSeen')) {
      throw new GatesError(400, 'Only preset, limit, overrides, allowedHosts, envKeep, trustFolder, untrustFolder, firstRunChoice and noticeSeen can be changed here.');
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
      // the same refusal as the editor, for a name this change adds: Legion's own keys and LEGION_ settings are never passed, so keeping one would
      // do nothing. Names already in the file stay readable and removable.
      const had = new Set((out.envKeep ?? []).map((n) => n.toUpperCase()));
      for (const x of l) {
        const up = x.toUpperCase();
        if (had.has(up)) continue;
        if ((ENV_NEVER_PASSED as readonly string[]).includes(up) || up.replace(/\*$/, '').startsWith(ENV_NEVER_PASSED_PREFIX)) throw new GatesError(400, `Legion never passes its own keys or ${ENV_NEVER_PASSED_PREFIX} settings to commands, so keeping "${x.slice(0, 60)}" would do nothing.`);
      }
      if (l.length) out.envKeep = l; else delete out.envKeep;
    }
    for (const k of ['untrustFolder', 'trustFolder'] as const) {
      if (!(k in body)) continue;
      if (!isApp) throw new GatesError(400, 'Trusted folders are set for the whole app, not per project.');
      const p = body[k];
      if (typeof p !== 'string' || !p.trim() || p.length > TRUSTED_FOLDER_PATH_MAX) throw new GatesError(400, 'Name the folder as text.');
      if (k === 'untrustFolder') {
        const real = realFolder(p);
        const keep = (out.trustedFolders ?? []).filter((e) => !sameFolder(e.folder, p) && !sameFolder(e.folder, real));
        if (keep.length) out.trustedFolders = keep; else delete out.trustedFolders;
        continue;
      }
      let isDir = false; try { isDir = statSync(p).isDirectory(); } catch { /* not there */ }
      if (!isDir) throw new GatesError(400, 'Legion could not find that folder.');
      // the core works the fingerprint out itself, here, from the folder as it is now: a name from the window is only ever a path
      const scan = this.scan(p);
      if (!scan.executable) throw new GatesError(400, 'Nothing in that folder needs your trust: it carries no settings or skills that can run a command.');
      if (scan.more > 0) throw new GatesError(400, 'That folder carries too many commands to list in the confirmation, so Legion will not trust it. Remove some, or work in it with the setting off.');
      const rec: TrustedFolderRecord = { folder: scan.folder, digest: scan.digest };
      const list = out.trustedFolders ?? [];
      if (list.some((e) => sameFolder(e.folder, rec.folder) && e.digest === rec.digest)) continue;
      const rest = list.filter((e) => !sameFolder(e.folder, rec.folder));
      if (rest.length >= TRUSTED_FOLDERS_MAX) throw new GatesError(400, `At most ${TRUSTED_FOLDERS_MAX} trusted folders. Remove one first.`);
      out.trustedFolders = [...rest, rec];
    }
    for (const flag of ['firstRunChoice', 'noticeSeen'] as const) {
      if (!(flag in body)) continue;
      if (!isApp) throw new GatesError(400, 'That note is kept for the whole app, not per project.');
      if (body[flag] !== true) throw new GatesError(400, flag + ' can only be set to true.');
      out[flag] = true;
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
      if (raw.trustedFolders !== undefined) {
        if (!isApp) throw new Error('trustedFolders');
        const l = parseTrusted(raw.trustedFolders); if (l.length) out.trustedFolders = l;
      }
      for (const flag of ['firstRunChoice', 'noticeSeen'] as const) {
        if (raw[flag] === undefined) continue;
        if (!isApp || raw[flag] !== true) throw new Error(flag);
        out[flag] = true;
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
    if (this.signer) {
      this.seq = gen; if (name !== 'app') this.fileGens.set(name, gen);
      // a signed file now exists: the key file is confirmed, and the "first start" marker has done its job
      try { rmSync(unconfirmedMarkerPath(dirname(this.folder)), { force: true }); } catch { /* a marker left behind means nothing next to a signed file */ }
    }
  }
}
