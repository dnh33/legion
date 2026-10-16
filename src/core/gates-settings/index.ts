/**
 * The gates settings module (spec section 4): the owner's presets per project and for the app, and the one resolver every
 * permission check asks for a run's mode. Routes are admin-only by the gate's default deny (none is a client route).
 * Settings that loosen anything need the app's native confirm (the per-launch native secret) and a key to sign with; without
 * the key only Ask can be stored, so a core without a keystore behaves exactly as 0.3.0 does.
 */
import { join } from 'node:path';
import type { ApprovalMode, LegionEvent } from '../../shared/types.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { effectiveMode } from '../permission-mode.js';
import type { ProjectStore } from '../projects/store.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { PRESETS } from '../../shared/gates-registry.js';
import { makeSigner } from './sign.js';
import { GatesError, GatesStore } from './store.js';
import type { GatesKeyState } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /**
   * The mode a tool call is judged by right now (spec 4.2). Called on every call, so a change takes effect on the next one.
   * `startProjectId` is the project the run started in (`job.projectAtStart`), never the live membership: fail closed.
   */
  mode(a: { agentMode: ApprovalMode; source?: 'own' | 'project'; startProjectId?: string; ceiling?: ApprovalMode }): ApprovalMode;
}
export interface GatesCore { store: GatesStore; resolver: ModeResolver }

/**
 * `keyring` is the gates key (its own key file; the per-launch secrets change on every start, so they cannot sign files that must
 * survive a restart). It is read once, here, after the launch pipe installed it. No key: no signer, only Ask can be stored.
 * `state()` says whether Electron made the key now (`new`) or it was there before (`old`, `lost`); see the store. A cap file or list
 * entry for a project missing from projects.json is kept: a damaged or edited projects.json must not remove a cap.
 */
export function createGatesCore(o: { dataDir: string; projects?: ProjectStore; keyring?: { get(): Buffer | undefined; state?(): GatesKeyState } }): GatesCore {
  const signer = makeSigner(o.keyring?.get());
  const store = new GatesStore(join(o.dataDir, 'gates'), { allowed: PRESETS, ...(signer ? { signer } : {}), ...(o.keyring?.state ? { keyState: o.keyring.state() } : {}) });
  const resolver: ModeResolver = {
    mode({ agentMode, source, startProjectId, ceiling }) {
      const ps = startProjectId ? store.project(startProjectId) : undefined;
      const m = effectiveMode({
        agentMode, source: source ?? 'own', appPreset: store.app().preset ?? 'ask',
        ...(ps ? { project: { ...(ps.preset ? { preset: ps.preset } : {}), limit: ps.limit ?? true } } : {}),
        ...(ceiling ? { ceiling } : {}),
      });
      // 'smart' cannot occur while only Ask is allowed; part 2 removes this guard together with the callers' support for it
      return m === 'smart' ? agentMode : m;
    },
  };
  return { store, resolver };
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
    // The file tools may not touch the gates folder, the key file, the project list or the config. A shell command may not work on the whole data
    // folder without a card (the engine's data-folder guard); reading stays free.
    protectedPaths: () => [store.folder, ...(opts.dataDir ? ['gates-key.bin', 'projects.json', 'config.json'].map((n) => join(opts.dataDir!, n)) : [])],
    shellProtectedPaths: () => (opts.dataDir ? [opts.dataDir] : []),
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
