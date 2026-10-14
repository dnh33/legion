/**
 * The gates settings module (spec section 4): the owner's presets per project and for the app, and the one resolver every
 * permission check asks for a run's mode. Routes are admin-only by the gate's default deny (none is a client route).
 * Part 1 accepts only the Ask preset, so the resolver returns exactly the agent's own mode (0.3.0 behavior).
 */
import { join } from 'node:path';
import type { ApprovalMode, LegionEvent } from '../../shared/types.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { effectiveMode } from '../permission-mode.js';
import type { ProjectStore } from '../projects/store.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { GatesError, GatesStore } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /**
   * The mode a tool call is judged by right now (spec 4.2). Called on every call, so a change takes effect on the next one.
   * `startProjectId` is the project the run started in (`job.projectAtStart`), never the live membership: fail closed.
   */
  mode(a: { agentMode: ApprovalMode; source?: 'own' | 'project'; startProjectId?: string; ceiling?: ApprovalMode }): ApprovalMode;
}
export interface GatesCore { store: GatesStore; resolver: ModeResolver }

/** Part 1: only Ask. Part 2 widens this list and teaches the callers about 'smart'. */
const PART_ONE_PRESETS = ['ask'] as const;

export function createGatesCore(o: { dataDir: string; projects?: ProjectStore }): GatesCore {
  const store = new GatesStore(join(o.dataDir, 'gates'), { allowed: PART_ONE_PRESETS });
  try { if (o.projects) store.prune(o.projects.list().map((p) => p.id)); } catch { /* the settings stay as they are */ }
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

export function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore }): GatesModule {
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
    protectedPaths: () => [store.folder],
    routes: (add) => {
      add('GET', '/api/gates/settings', () => store.view(opts.projects.list().map((p) => p.id)));
      add('PATCH', '/api/gates/app', (c) => { const r = wrap(() => store.patchApp(body(c))); emit(); return r; });
      add('PATCH', '/api/gates/projects/:id', (c) => { const id = must(c.params[0]); const r = wrap(() => store.patchProject(id, body(c))); emit(); return r; });
      add('POST', '/api/gates/reload', () => { store.reload(); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
    },
    dispose: async () => { await store.flush(); },
  };
}
