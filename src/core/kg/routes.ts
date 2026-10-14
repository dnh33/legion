/** HTTP API under /api/kg. Bearer auth is already enforced by the dispatcher; every caller here is the human. */
import { KG_LIMITS } from '../../shared/kg.js';
import type { KgLintReport, KgNode } from '../../shared/kg.js';
import type { Task } from '../../shared/types.js';
import { EngineError } from '../engine.js';
import { HttpError } from '../server.js';
import type { Ctx, Handler } from '../server.js';
import type { RouteAdder } from '../modules.js';
import type { Graph } from './graph.js';
import { applySeedPack, BSV_SEED_PATH, loadBsvSeed, summarizeBsvPack } from './seed.js';
import { agentActor, HUMAN, KgError } from './types.js';
import type { NodeInput } from './types.js';
import { buildRefreshPrompt, MAX_LIVE_REFRESHES, refreshBlockOf, refreshCheck } from './refresh.js';
import { exportLibrary, exportVault, importVault } from './vault.js';

export interface RouteDeps {
  graph: () => Graph;
  bsvEnabled: () => boolean;
  /** Overridable for tests. */
  seedPath?: string;
  /** What "Refresh" needs from the core: the agent that does it, a clock, a way to start its run and to ask whether a run is still live. */
  refresh?: {
    agentId: string;
    now(): number;
    start(a: { prompt: string; projectId?: string }): Task;
    isLive(taskId: string): boolean;
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function intParam(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}
function strParam(url: URL, name: string, required = false): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v.trim() === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return undefined;
  }
  return v;
}
const listParam = (url: URL, name: string): string[] | undefined => strParam(url, name)?.split(',').map((s) => s.trim()).filter(Boolean);
function bodyObj(b: unknown): Record<string, unknown> {
  if (!isObj(b)) throw new HttpError(400, 'JSON object body required');
  return b;
}

/** Maps graph errors onto HTTP statuses. */
const wrap = (fn: (c: Ctx) => unknown | Promise<unknown>): Handler => async (c) => {
  try { return await fn(c); } catch (e) {
    if (e instanceof KgError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function addKgRoutes(add: RouteAdder, d: RouteDeps): void {
  const g = () => d.graph();
  /** node id -> the Archivist run refreshing it. An entry whose run has ended is dropped the next time it is read. */
  const refreshing = new Map<string, string>();
  const liveRefresh = (nodeId: string): string | undefined => {
    const taskId = refreshing.get(nodeId);
    if (taskId === undefined) return undefined;
    if (d.refresh?.isLive(taskId)) return taskId;
    refreshing.delete(nodeId);
    return undefined;
  };
  const liveRefreshCount = (): number => { let n = 0; for (const id of [...refreshing.keys()]) if (liveRefresh(id)) n++; return n; };
  /** What the core knows about a note for the refresh rules: can the Archivist read it, and does a proposal for it already wait. */
  const refreshEnv = (n: KgNode, targets?: ReadonlySet<string>) => ({
    archivistCanSee: d.refresh ? g().canSeeNode(agentActor(d.refresh.agentId, n.projectId ? { projectId: n.projectId } : {}), n) : true,
    hasProposal: targets ? targets.has(n.id) : g().hasPendingProposalFor(n.id),
  });

  add('GET', '/api/kg/stats', wrap(() => ({ ...g().stats(HUMAN), bsvAvailable: d.bsvEnabled() })));

  add('GET', '/api/kg/overview', wrap(({ url }) => g().overview(HUMAN, intParam(url, 'limit', 1, 200))));

  add('GET', '/api/kg/search', wrap(({ url }) => {
    const q = strParam(url, 'q', true)!;
    return g().search(HUMAN, q, {
      scope: strParam(url, 'scope'), type: strParam(url, 'type'), tags: listParam(url, 'tags'), limit: intParam(url, 'limit', 1, 50),
      includeInactive: strParam(url, 'includeInactive') === '1',
    });
  }));

  add('GET', '/api/kg/nodes/:id', wrap(({ params }) => {
    const node = g().getNode(HUMAN, params[0]!);
    if (!node) throw new HttpError(404, `Unknown node "${params[0]}"`);
    // each edge also carries the title and type of its other endpoint, so the UI need not fetch every neighbour
    const edges = g().edgesOf(HUMAN, node.id).map((e) => {
      const other = g().getNode(HUMAN, e.from === node.id ? e.to : e.from);
      return { ...e, title: other?.title ?? '', type: other?.type ?? 'note' };
    });
    return { node, edges: { out: edges.filter((e) => e.from === node.id), in: edges.filter((e) => e.to === node.id) } };
  }));

  add('POST', '/api/kg/nodes', wrap(({ body }) => {
    const b = bodyObj(body);
    const input: NodeInput = {};
    for (const k of ['id', 'type', 'title', 'body', 'tags', 'scope', 'props', 'sources', 'confidence', 'untrusted'] as const) {
      if (b[k] !== undefined) (input as Record<string, unknown>)[k] = b[k];
    }
    const r = g().upsertNode(HUMAN, input);
    return { node: r.node, created: r.created };
  }));

  add('DELETE', '/api/kg/nodes/:id', wrap(({ params }) => ({ ok: true, ...g().deleteNode(HUMAN, params[0]!) })));

  add('GET', '/api/kg/nodes/:id/neighbors', wrap(({ params, url }) => {
    const dir = strParam(url, 'dir');
    if (dir !== undefined && dir !== 'out' && dir !== 'in' && dir !== 'both') throw new HttpError(400, 'dir must be out, in or both');
    return g().neighbors(HUMAN, params[0]!, {
      rel: strParam(url, 'rel'), dir: dir as 'out' | 'in' | 'both' | undefined,
      depth: intParam(url, 'depth', 1, KG_LIMITS.maxDepth), limit: intParam(url, 'limit', 1, 200),
    });
  }));

  add('GET', '/api/kg/path', wrap(({ url }) => g().path(HUMAN, strParam(url, 'from', true)!, strParam(url, 'to', true)!, {
    maxDepth: intParam(url, 'maxDepth', 1, 10), rels: listParam(url, 'rels'),
  })));

  add('POST', '/api/kg/edges', wrap(({ body }) => {
    const b = bodyObj(body);
    const r = g().link(HUMAN, { from: b.from as string, to: b.to as string, rel: b.rel as string, weight: b.weight as number | undefined, note: b.note as string | undefined });
    return { edge: r.edge, created: r.created };
  }));

  // change an edge's relation, note or weight (human only; node edits and retyping go through POST /api/kg/nodes with an id)
  add('PATCH', '/api/kg/edges/:id', wrap(({ params, body }) => {
    const b = bodyObj(body);
    if (b.rel !== undefined && typeof b.rel !== 'string') throw new HttpError(400, 'rel must be a string');
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') throw new HttpError(400, 'note must be a string (or null to clear it)');
    if (b.weight !== undefined && b.weight !== null && typeof b.weight !== 'number') throw new HttpError(400, 'weight must be a number (or null to clear it)');
    return { edge: g().updateEdge(HUMAN, params[0]!, { rel: b.rel as string | undefined, note: b.note as string | null | undefined, weight: b.weight as number | null | undefined }) };
  }));

  add('DELETE', '/api/kg/edges/:id', wrap(({ params }) => ({ ok: true, edge: g().unlink(HUMAN, { id: params[0]! }) })));

  add('GET', '/api/kg/subgraph', wrap(({ url }) => {
    const seeds = listParam(url, 'seed');
    if (!seeds?.length) throw new HttpError(400, 'seed is required (comma-separated node ids)');
    const depth = url.searchParams.get('depth');
    const sub = g().subgraph(HUMAN, seeds, {
      depth: depth === null || depth === '' ? undefined : intParam(url, 'depth', 0, KG_LIMITS.maxDepth), maxNodes: intParam(url, 'max', 1, 500),
    });
    if (!sub.nodes.length) throw new HttpError(404, 'None of the seed ids exist');
    return sub;
  }));

  // The stale rows carry what the Lint tab shows (title, type, sources, confidence, author) and the live Archivist run, if any.
  add('GET', '/api/kg/lint', wrap((): KgLintReport => {
    const report = g().lint(HUMAN);
    const targets = g().pendingProposalTargets(); // once per request, not once per row
    return {
      ...report,
      stale: report.stale.map((row) => {
        const n = g().peekNode(HUMAN, row.id);
        if (!n) return row;
        const taskId = liveRefresh(n.id);
        return {
          ...row, title: n.title, type: n.type, sourceCount: n.sources?.length ?? 0, createdBy: n.createdBy,
          ...(n.confidence !== undefined ? { confidence: n.confidence } : {}), ...(n.projectId ? { projectId: n.projectId } : {}),
          ...(taskId ? { refreshTaskId: taskId } : {}),
          ...(d.refresh && n.createdBy !== 'system' ? (() => { const b = refreshBlockOf(n as KgNode, refreshEnv(n as KgNode, targets)); return b ? { refreshBlock: b.block } : {}; })() : {}),
        };
      }),
    };
  }));

  // "Refresh" on a stale note: one Archivist run that re-checks its sources and proposes an update (it lands in the Inbox). Admin-only by
  // default-deny (not in admin.ts CLIENT_ROUTES). One run per note at a time.
  add('POST', '/api/kg/nodes/:id/refresh', wrap(({ params }) => {
    const r = d.refresh;
    if (!r) throw new HttpError(503, 'Refreshing notes is not available in this build.');
    const n = g().getNode(HUMAN, params[0]!);
    if (!n) throw new HttpError(404, `Unknown node "${params[0]}"`);
    const check = refreshCheck(n, r.now(), refreshEnv(n));
    if (!check.ok) throw new HttpError(check.status, check.message);
    if (liveRefresh(n.id)) throw new HttpError(409, 'This note is already being refreshed. Open the run to follow it.');
    if (liveRefreshCount() >= MAX_LIVE_REFRESHES) throw new HttpError(409, 'Three refreshes are running. Wait for one to finish.');
    let task: Task;
    try {
      task = r.start({ prompt: buildRefreshPrompt(n, check.daysOld), ...(n.projectId ? { projectId: n.projectId } : {}) });
    } catch (e) {
      if (e instanceof EngineError && e.status === 404) throw new HttpError(404, 'The Archivist is not on your roster, so nothing can refresh this note. Add the Archivist back, then try again.');
      throw e;
    }
    refreshing.set(n.id, task.id);
    return { taskId: task.id };
  }));

  // ---- the human's inbox and Activity list. Graph methods refuse any bot actor; none of this is a kg_* tool.
  // "Still current": the owner checked the note and it holds. A plain touch: updatedAt moves to now, nothing else changes. Admin-only by default-deny.
  add('POST', '/api/kg/nodes/:id/checked', wrap(({ params }) => {
    const n = g().getNode(HUMAN, params[0]!);
    if (!n) throw new HttpError(404, `Unknown node "${params[0]}"`);
    if (n.createdBy === 'system') throw new HttpError(409, 'Built-in notes ship with Legion and update with it. There is nothing to mark.');
    g().touch(HUMAN, n.id);
    return { ok: true };
  }));

  add('GET', '/api/kg/inbox', wrap(({ url }) => g().inbox(HUMAN, { agentId: strParam(url, 'agent') })));

  add('POST', '/api/kg/inbox/accept', wrap(({ body }) => {
    const b = isObj(body) ? body : {};
    if (b.ids !== undefined && (!Array.isArray(b.ids) || b.ids.some((x) => typeof x !== 'string'))) throw new HttpError(400, 'ids must be an array of node ids');
    return g().acceptMany(HUMAN, {
      ids: b.ids as string[] | undefined, agentId: typeof b.agent === 'string' ? b.agent : undefined, overrideUntrusted: b.overrideUntrusted === true,
    });
  }));

  add('POST', '/api/kg/inbox/:id/accept', wrap(({ params, body }) => {
    const b = isObj(body) ? body : {};
    const e = isObj(b.edit) ? b.edit : undefined;
    if (e && ((e.title !== undefined && typeof e.title !== 'string') || (e.body !== undefined && typeof e.body !== 'string')
      || (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== 'string'))))) throw new HttpError(400, 'edit.title and edit.body must be strings, edit.tags an array of strings');
    return { node: g().acceptPending(HUMAN, params[0]!, e ? { edit: { title: e.title as string | undefined, body: e.body as string | undefined, tags: e.tags as string[] | undefined } } : {}) };
  }));

  add('POST', '/api/kg/inbox/:id/reject', wrap(({ params }) => ({ node: g().rejectPending(HUMAN, params[0]!) })));

  add('GET', '/api/kg/activity', wrap(({ url }) => g().activityFeed(HUMAN, { limit: intParam(url, 'limit', 1, 200), agentId: strParam(url, 'agent') })));

  add('POST', '/api/kg/activity/:id/undo', wrap(({ params }) => ({ entry: g().undo(HUMAN, params[0]!) })));

  add('POST', '/api/kg/import', wrap(({ body }) => {
    const dir = bodyObj(body).dir;
    if (typeof dir !== 'string' || !dir.trim()) throw new HttpError(400, 'dir (path of the vault folder) is required');
    return importVault(g(), dir, HUMAN, { userInitiated: true });
  }));

  add('POST', '/api/kg/export', wrap(({ body }) => {
    const b = bodyObj(body);
    const dir = b.dir;
    if (typeof dir !== 'string' || !dir.trim()) throw new HttpError(400, 'dir (target folder) is required');
    // mode "library": mirror the bots' shared notes into <dir>/legion/ only; the default exports everything into dir itself
    if (b.mode !== undefined && b.mode !== 'all' && b.mode !== 'library') throw new HttpError(400, 'mode must be "all" or "library"');
    return b.mode === 'library' ? exportLibrary(g(), dir) : exportVault(g(), HUMAN, dir);
  }));

  // READ ONLY: what the graph holds in scope bsv against the bundled pack, by node id (the title-bar number and its explanation). Writes nothing.
  add('GET', '/api/kg/seed/bsv', wrap(() => {
    if (!d.bsvEnabled()) throw new HttpError(409, 'BSV mode is off.');
    return summarizeBsvPack(g(), d.seedPath ?? BSV_SEED_PATH);
  }));

  // body {restore:[node ids]}: bring named pack nodes back (deleted ones with their links, edited ones reset to the pack text)
  add('POST', '/api/kg/seed/bsv', wrap(({ body }) => {
    if (!d.bsvEnabled()) throw new HttpError(409, 'BSV mode is off: turn on the BSV Dev Kit toggle before loading the BSV knowledge pack.');
    const b = isObj(body) ? body : {};
    if (b.restore !== undefined && (!Array.isArray(b.restore) || b.restore.some((x) => typeof x !== 'string'))) throw new HttpError(400, 'restore must be an array of pack node ids');
    return { ok: true, ...applySeedPack(g(), loadBsvSeed(d.seedPath ?? BSV_SEED_PATH), { restore: b.restore as string[] | undefined }) };
  }));
}
