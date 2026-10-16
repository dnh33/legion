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
import { PRESETS, gateValue } from '../../shared/gates-registry.js';
import type { GateValue, Preset } from '../../shared/gates-registry.js';
import { makeSigner } from './sign.js';
import { GatesError, GatesStore } from './store.js';
import type { GatesKeyState } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /**
   * The mode a tool call is judged by right now (spec 4.2). Called on every call, so a change takes effect on the next one.
   * `startProjectId` is the project the run started in (`job.projectAtStart`, or the helped project for an outside helper), never the live membership: fail closed.
   * `source` is read from disk, so it is not trusted: anything but 'own' or 'project' (absent counts as 'own') gives Ask.
   */
  mode(a: { agentMode: ApprovalMode; source?: unknown; startProjectId?: string; ceiling?: ApprovalMode; goal?: { autonomy: GoalAutonomy; lease?: Preset } }): RunMode;
  /** What the run would be judged by with no presets at all (the would-have-asked comparison). Optional so a bare `{ mode }` stays a resolver. */
  baseline?(a: { agentMode: ApprovalMode; source?: unknown; ceiling?: ApprovalMode }): RunMode;
}
export interface GatesCore { store: GatesStore; resolver: ModeResolver; /** The value of a gate for a run that started in `startProjectId` (the project's override, else the app's, else the preset's). */ gate(id: string, startProjectId?: string): GateValue }

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
  return { store, resolver, gate };
}

export interface GatesModule extends CoreModule { store: GatesStore }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A change that loosens a gate comes from the Legion app's main process after its own confirmation dialog, never the window and never a token client. */
export function requireNative(c: Ctx, o: { nativeSecret?: string }): void {
  if (!o.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
  const given = (c.req.headers as Record<string, string | string[] | undefined>)[NATIVE_HEADER];
  if (typeof given !== 'string' || !safeEqual(given, o.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: a change that loosens a gate comes only from the app after its confirmation dialog');
}

export function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore; nativeSecret?: string; dataDir?: string }): GatesModule {
  const { store } = opts.core;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) { if (e instanceof GatesError) throw new HttpError(e.status, e.message); throw e; }
  };
  const emit = (): void => { try { deps.bus.emit({ type: 'gates.updated' }); } catch { /* advisory */ } };
  const must = (id: string | undefined): string => {
    if (!id || !opts.projects.get(id)) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return id;
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
        if (store.isLoosening('app', b)) requireNative(c, opts);
        const r = wrap(() => store.patchApp(b)); emit(); return r;
      });
      add('PATCH', '/api/gates/projects/:id', (c) => {
        const id = must(c.params[0]); const b = body(c);
        if (store.isLoosening(id, b)) requireNative(c, opts);
        const r = wrap(() => store.patchProject(id, b)); emit(); return r;
      });
      // A file changed outside Legion: Accept applies what is on disk (a loosening, so native only); Keep mine rewrites what the core holds.
      add('POST', '/api/gates/accept/:name', (c) => { requireNative(c, opts); const r = wrap(() => store.accept(c.params[0] ?? '')); emit(); return r; });
      add('POST', '/api/gates/keep/:name', (c) => { wrap(() => store.keepMine(c.params[0] ?? '', opts.projects.list().map((p) => p.id))); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
      add('POST', '/api/gates/reload', () => { wrap(() => store.reload()); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
    },
    dispose: async () => { await store.flush(); },
  };
}
