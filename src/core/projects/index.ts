/** Projects module: owner-only routes. See claude/plan-projects.md. Every route is admin-only by the gate's default deny; folder and member changes also need the native secret. */
import type { Project } from '../../shared/projects.js';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { agentVisible } from '../visibility.js';
import { PROJECT_LIMITS } from '../../shared/projects.js';
import { ProjectError } from './store.js';
import type { ProjectStore } from './store.js';

export { ProjectStore, ProjectError } from './store.js';
export { projectSection } from './prompt.js';

export interface ProjectsModuleOpts { projects: ProjectStore; nativeSecret?: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createProjectsModule(deps: ModuleDeps, opts: ProjectsModuleOpts): CoreModule {
  const { projects } = opts;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof ProjectError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  const body = (c: Ctx): Record<string, unknown> => {
    if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required');
    return c.body;
  };
  /** Folder and member changes: the Legion app's main process after its own native confirmation, never the window and never a token client. */
  const requireNative = (c: Ctx): void => {
    if (!opts.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
    const given = (c.req.headers as Record<string, string | string[] | undefined>)[NATIVE_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, opts.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: folder and member changes come only from the app after its confirmation dialog');
  };
  const emit = (p: Project): Project => { try { deps.bus.emit({ type: 'project.updated', project: p }); } catch { /* advisory */ } return p; };

  return {
    id: 'projects',
    routes: (add) => {
      add('GET', '/api/projects', () => projects.list());
      add('GET', '/api/projects/:id', ({ params }) => {
        const p = projects.get(params[0]!);
        if (!p) throw new HttpError(404, `Unknown project "${params[0]}"`);
        return p;
      });
      add('POST', '/api/projects', (c) => {
        const b = body(c);
        if (b.folder !== undefined || b.members !== undefined) throw new HttpError(400, 'A new project takes a name and instructions only. Set its folder and members afterwards: they need a confirmation from the app.');
        return emit(wrap(() => projects.create({ name: b.name, instructions: b.instructions })));
      }, 201);
      add('PATCH', '/api/projects/:id', (c) => {
        const b = body(c);
        if (b.folder !== undefined || b.members !== undefined) throw new HttpError(400, 'Folder and members are changed through their own routes, with a confirmation from the app.');
        return emit(wrap(() => projects.update(c.params[0]!, { name: b.name, instructions: b.instructions, status: b.status })));
      });
      add('PUT', '/api/projects/:id/members', (c) => {
        requireNative(c);
        const b = body(c);
        const list = b.members;
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new HttpError(400, 'members must be an array of agent ids');
        if (list.length > PROJECT_LIMITS.members) throw new HttpError(400, `A project has at most ${PROJECT_LIMITS.members} members`);
        for (const id of list as string[]) {
          const a = deps.store.getAgent(id);
          if (!a || !agentVisible({ bsvEnabled: deps.bsvEnabled }, a)) throw new HttpError(400, `Unknown agent "${id}"`);
        }
        return emit(wrap(() => projects.setMembers(c.params[0]!, list as string[])));
      });
      add('PUT', '/api/projects/:id/folder', (c) => {
        requireNative(c);
        const b = body(c);
        if (b.folder !== null && typeof b.folder !== 'string') throw new HttpError(400, 'folder must be a path, or null for the default folder');
        return emit(wrap(() => projects.setFolder(c.params[0]!, b.folder)));
      });
    },
    dispose: async () => { await projects.flush(); },
  };
}
