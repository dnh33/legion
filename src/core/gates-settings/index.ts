/**
 * The gates settings module (spec section 4): the owner's presets per project and for the app, and the one resolver every
 * permission check asks for a run's mode. Routes are admin-only by the gate's default deny (none is a client route).
 * Settings that loosen anything need the app's native confirm (the per-launch native secret) and a key to sign with; without
 * the key only Ask can be stored, so a core without a keystore behaves exactly as 0.3.0 does.
 */
import { join } from 'node:path';
import { dataFolderTargets } from '../exec/canonical-path.js';
import type { ApprovalMode, LegionEvent } from '../../shared/types.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { baselineMode, effectiveMode } from '../permission-mode.js';
import type { GoalAutonomy, RunMode } from '../permission-mode.js';
import type { ProjectStore } from '../projects/store.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { DENY_LINE, GATES, GATES_DIGEST_HEADER, NO_SANDBOX_LINE, PRESETS, gateValue } from '../../shared/gates-registry.js';
import type { GateValue, Preset } from '../../shared/gates-registry.js';
import { createBuildEdited } from './build-edited.js';
import type { BuildEdited } from './build-edited.js';
import { makeSigner } from './sign.js';
import { GatesError, GatesStore, PRESET_NAME } from './store.js';
import type { ActivityLog } from '../activity/index.js';
import type { GatesKeyState } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /**
   * The mode a tool call is judged by right now (spec 4.2). Called on every call, so a change takes effect on the next one.
   * `startProjectId` is the project the run started in (`job.projectAtStart`, or the helped project for an outside helper), never the live membership: fail closed.
   * `source` is read from disk, so it is not trusted: anything but 'own' or 'project' (absent counts as 'own') gives Ask.
   */
  mode(a: { agentMode: ApprovalMode; source?: unknown; startProjectId?: string; ceiling?: RunMode; goal?: { autonomy: GoalAutonomy; lease?: Preset } }): RunMode;
  /** What the run would be judged by with no presets at all (the would-have-asked comparison). Optional so a bare `{ mode }` stays a resolver. */
  baseline?(a: { agentMode: ApprovalMode; source?: unknown; ceiling?: RunMode }): RunMode;
}
export interface GatesCore {
  store: GatesStore; resolver: ModeResolver;
  /** The value of a gate for a run that started in `startProjectId` (the project's override, else the app's, else the preset's). */
  gate(id: string, startProjectId?: string): GateValue;
  /**
   * True when the owner switched this gate off beyond what the preset already does: its value is off while the preset's own value is on.
   * Bypass has `tool-cards` off by preset, and an agent set to Ask still asks there (the preset moves agents that follow it); an override
   * that turns the cards off is the owner's explicit word for every agent of the project.
   */
  switchedOff(id: string, startProjectId?: string): boolean;
  /** Projects where an agent changed a build or script file and the owner has not yet allowed a build or test command (Smart asks for those). Not a gate: its own store, not signed. */
  buildEdited: BuildEdited;
}

/**
 * `keyring` is the gates key (its own key file; the per-launch secrets change on every start, so they cannot sign files that must
 * survive a restart). It is read once, here, after the launch pipe installed it. No key: no signer, only Ask can be stored.
 * `state()` says whether Electron made the key now (`new`) or it was there before (`old`, `lost`); see the store. A cap file or list
 * entry for a project missing from projects.json is kept: a damaged or edited projects.json must not remove a cap.
 */
export function createGatesCore(o: { dataDir: string; projects?: ProjectStore; keyring?: { get(): Buffer | undefined; state?(): GatesKeyState } }): GatesCore {
  const signer = makeSigner(o.keyring?.get());
  const store = new GatesStore(join(o.dataDir, 'gates'), { allowed: PRESETS, ...(signer ? { signer } : {}), ...(o.keyring?.state ? { keyState: o.keyring.state() } : {}) });
  // A source that is neither 'own' nor 'project' (a damaged agent record) fails closed to Ask, before any preset is read.
  const sourceOf = (source: unknown): 'own' | 'project' | undefined => (source === undefined || source === 'own' ? 'own' : source === 'project' ? 'project' : undefined);
  const resolver: ModeResolver = {
    mode({ agentMode, source, startProjectId, ceiling, goal }) {
      const src = sourceOf(source);
      if (!src) return 'ask';
      const ps = startProjectId ? store.project(startProjectId) : undefined;
      return effectiveMode({
        agentMode, source: src, appPreset: store.app().preset ?? 'ask',
        ...(ps ? { project: { ...(ps.preset ? { preset: ps.preset } : {}), limit: ps.limit ?? true } } : {}),
        ...(goal ? { goal } : {}),
        ...(ceiling ? { ceiling } : {}),
      });
    },
    baseline({ agentMode, source, ceiling }) {
      const src = sourceOf(source);
      return src ? baselineMode({ agentMode, source: src, ...(ceiling ? { ceiling } : {}) }) : 'ask';
    },
  };
  const gate = (id: string, startProjectId?: string): GateValue => gateValue(id, { app: store.app(), ...(startProjectId ? { project: store.project(startProjectId) } : {}) });
  const switchedOff = (id: string, startProjectId?: string): boolean => {
    if (gate(id, startProjectId) !== false) return false;
    const def = GATES.find((g) => g.id === id)?.defaults;
    if (!def || def === 'always') return false;
    const preset: Preset = (startProjectId ? store.project(startProjectId).preset : undefined) ?? store.app().preset ?? 'ask';
    return def[preset] !== false;
  };
  return { store, resolver, gate, switchedOff, buildEdited: createBuildEdited(store.folder) };
}

export interface GatesModule extends CoreModule { store: GatesStore }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A change that loosens a gate comes from the Legion app's main process after its own confirmation dialog, never the window and never a token client. */
export function requireNative(c: Ctx, o: { nativeSecret?: string }): void {
  if (!o.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
  const given = (c.req.headers as Record<string, string | string[] | undefined>)[NATIVE_HEADER];
  if (typeof given !== 'string' || !safeEqual(given, o.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: a change that loosens a gate comes only from the app after its confirmation dialog');
}

/**
 * The app confirmed one exact change: its digest rides with the request, and the core refuses a change that would give different settings
 * (a file swapped, or another edit landed, while the dialog was open). A loosening must carry it; a change that does not loosen needs it only if sent.
 */
export function requireDigest(c: Ctx, expected: () => string, required: boolean): void {
  const given = (c.req.headers as Record<string, string | string[] | undefined>)[GATES_DIGEST_HEADER];
  const want = expected(); // first, so a body that is not valid gets its own 400
  if (typeof given !== 'string') { if (required) throw new HttpError(409, 'The change differs from what you confirmed'); return; }
  if (!safeEqual(given, want)) throw new HttpError(409, 'The change differs from what you confirmed');
}

export function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore; nativeSecret?: string; dataDir?: string; /** Every successful change writes `gate-changed` lines here. */ activity?: ActivityLog }): GatesModule {
  const { store } = opts.core;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) { if (e instanceof GatesError) throw new HttpError(e.status, e.message); throw e; }
  };
  const emit = (): void => { try { deps.bus.emit({ type: 'gates.updated' }); } catch { /* advisory */ } };
  const must = (id: string | undefined): string => {
    if (!id || !opts.projects.get(id)) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return id;
  };
  /** The sentences of a patch, read before it is applied (the store's own wording, so the log says what the dialog said). Empty when it cannot be previewed. */
  const linesOf = (name: string, b: Record<string, unknown>): string[] => {
    try { return store.preview(name, b).lines.filter((l) => l !== DENY_LINE && l !== NO_SANDBOX_LINE && !l.startsWith('The preset is now ')); } catch { return []; }
  };
  const scopeOf = (name: string): string => (name === 'app' ? 'all projects' : `project ${opts.projects.get(name)?.name ?? name}`);
  const logChange = (name: string, headline: string, lines: string[] = []): void => {
    if (!opts.activity) return;
    const projectId = name === 'app' ? undefined : name;
    // the change is already applied: a log problem must never turn it into an error answer
    try { for (const text of [headline, ...lines.slice(0, 8)]) opts.activity.append({ kind: 'gate-changed', text, ...(projectId ? { projectId } : {}), data: { scope: name === 'app' ? 'app' : 'project' } }); } catch { /* logged nothing */ }
  };
  const headlineOf = (name: string, b: Record<string, unknown>): string => {
    const scope = scopeOf(name);
    if ('preset' in b) return `Preset set to ${typeof b.preset === 'string' && b.preset in PRESET_NAME ? PRESET_NAME[b.preset as keyof typeof PRESET_NAME] : 'Per agent'} for ${scope}`;
    if ('limit' in b) return `Agent limit turned ${b.limit === false ? 'off' : 'on'} for ${scope}`;
    return `Gate settings changed for ${scope}`;
  };
  const body = (c: Ctx): Record<string, unknown> => { if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required'); return c.body; };
  return {
    id: 'gates', store,
    // One protected set for the file tools and the shell guard: the gates folder, the key file, config, state and the project list (not agents' workspaces).
    protectedPaths: () => [store.folder, ...(opts.dataDir ? dataFolderTargets(opts.dataDir) : [])],
    routes: (add) => {
      add('GET', '/api/gates/settings', () => store.view(opts.projects.list().map((p) => p.id)));
      add('PATCH', '/api/gates/app', (c) => {
        const b = body(c);
        const loosens = store.isLoosening('app', b);
        if (loosens) requireNative(c, opts);
        requireDigest(c, () => wrap(() => store.preview('app', b)).digest, loosens);
        const lines = linesOf('app', b);
        const r = wrap(() => store.patchApp(b)); logChange('app', headlineOf('app', b), lines); emit(); return r;
      });
      add('PATCH', '/api/gates/projects/:id', (c) => {
        const id = must(c.params[0]); const b = body(c);
        const loosens = store.isLoosening(id, b);
        if (loosens) requireNative(c, opts);
        requireDigest(c, () => wrap(() => store.preview(id, b)).digest, loosens);
        const lines = linesOf(id, b);
        const r = wrap(() => store.patchProject(id, b)); logChange(id, headlineOf(id, b), lines); emit(); return r;
      });
      // A file changed outside Legion: Accept applies what is on disk (a loosening, so native only); Keep mine rewrites what the core holds.
      add('POST', '/api/gates/accept/:name', (c) => { requireNative(c, opts); requireDigest(c, () => wrap(() => store.previewAccept(c.params[0] ?? '')).digest, true); const name = c.params[0] ?? ''; const r = wrap(() => store.accept(name)); logChange(name, `Applied the settings file that changed outside Legion for ${scopeOf(name)}`); emit(); return r; });
      add('POST', '/api/gates/keep/:name', (c) => { const name = c.params[0] ?? ''; wrap(() => store.keepMine(name, opts.projects.list().map((p) => p.id))); logChange(name, `Kept the settings Legion holds for ${scopeOf(name)}`); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
      // What a change would do, in plain sentences, and the digest of the result. The app words its dialog from this and nothing else.
      add('POST', '/api/gates/preview', (c) => {
        const b = body(c);
        if (Object.keys(b).some((k) => k !== 'name' && k !== 'patch' && k !== 'accept')) throw new HttpError(400, 'Only name, patch and accept can be sent.');
        const name = b.name;
        if (typeof name !== 'string') throw new HttpError(400, 'name is required.');
        if (name !== 'app') must(name);
        if (b.accept === true) return wrap(() => store.previewAccept(name));
        if (!isObj(b.patch)) throw new HttpError(400, 'patch must be an object.');
        return wrap(() => store.preview(name, b.patch as Record<string, unknown>));
      });
      add('POST', '/api/gates/reload', () => { wrap(() => store.reload()); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
    },
    dispose: async () => { await store.flush(); },
  };
}
