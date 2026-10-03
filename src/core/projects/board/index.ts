/**
 * Project board module (a feature, on by default: built unless its feature switch in config.json is false).
 * Owner routes are admin-only by the gate's default deny. The board never executes anything by itself; "Run this item" is the owner's click.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { BOARD_LIMITS } from '../../../shared/board.js';
import type { WorkItem } from '../../../shared/board.js';
import type { Project } from '../../../shared/projects.js';
import type { TaskOrigin } from '../../../shared/comms.js';
import type { CoreModule, ModuleDeps } from '../../modules.js';
import { HttpError } from '../../server.js';
import type { Ctx } from '../../server.js';
import type { ProjectStore } from '../store.js';
import { BOARD_PREAMBLE, boardDigest, runPrompt } from './prompt.js';
import type { BoardNotes } from './notes.js';
import { BoardError } from './store.js';
import type { BoardStore } from './store.js';
import { buildBoardToolsServer } from './tools.js';

export { BoardStore, BoardError } from './store.js';
export { registerBoardRead } from './mcp.js';
export { graphNotes } from './notes.js';
export type { BoardNotes } from './notes.js';

export interface BoardModuleOpts { projects: ProjectStore; board: BoardStore; /** The project Library (absent in tests that do not need it): note links, automatic linking and "save what we learned". */ notes?: BoardNotes }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The approval ceiling of a run on text no human has read: the same as a token client's run. */
const UNTRUSTED_ORIGIN: TaskOrigin = { roomId: 'board', fromAgentId: 'board', hop: 0, approvalCeiling: 'ask', tainted: true };

export function createBoardModule(deps: ModuleDeps, opts: BoardModuleOpts): CoreModule {
  const { projects, board, notes } = opts;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof BoardError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  const body = (c: Ctx): Record<string, unknown> => { if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required'); return c.body; };
  const proj = (id: string | undefined): Project => {
    const p = id ? projects.get(id) : undefined;
    if (!p) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return p;
  };
  /** Advisory, carries no item text: the window re-reads the board. */
  const changed = (projectId: string): void => { try { deps.bus.emit({ type: 'board.updated', projectId }); } catch { /* advisory */ } };
  const out = <T>(projectId: string, v: T): T => { changed(projectId); return v; };

  return {
    id: 'project-board',
    mcpServers: (agent, job): Record<string, McpServerConfig> => {
      // no project (or not an active one this agent belongs to) = no board tool at all
      if (!job?.projectId || !projects.forRun(job.projectId, agent.id)) return {};
      return { legion_board: buildBoardToolsServer(agent.id, { board, projects, onChange: changed, ...(notes ? { notes } : {}), askOwner: (r) => deps.approvals.request(r.taskId, r.agentId, `mcp__legion_board__${r.tool}`, r.input, r.origin, { summary: r.summary }) }, job) };
    },
    preamble: (agent, ctx) => {
      const p = ctx?.projectId ? projects.forRun(ctx.projectId, agent.id) : undefined;
      if (!p) return '';
      let digest = '';
      try { digest = boardDigest(board.view(p).items, agent.id, (id) => deps.store.getAgent(id)?.name ?? id, undefined, notes?.recent(p.id) ?? []); } catch { /* the digest is a convenience */ }
      return digest ? `${BOARD_PREAMBLE}\n${digest}` : BOARD_PREAMBLE;
    },
    onTaskEnd: (task, _agent, outcome) => {
      if (!task.projectId) return;
      const r = board.endRun(task.projectId, task.id, { status: task.status, isError: outcome.isError, text: task.result ?? task.error ?? outcome.errorText, tainted: outcome.tainted });
      // notes the run saved in the project Library are linked to the item(s) it worked on: the one it was started for, or the ones it updated
      try {
        if (notes) {
          const found = notes.byTask(task.id, task.projectId);
          if (found.length) for (const it of board.itemsForTask(task.projectId, task.id)) board.linkNotes(task.projectId, it.id, found, { kind: 'system' });
        }
      } catch { /* a convenience: never disturbs the engine */ }
      if (r || notes) changed(task.projectId);
    },
    routes: (add) => {
      add('GET', '/api/board', () => ({ enabled: true, limits: BOARD_LIMITS, notes: !!notes }));
      add('GET', '/api/projects/:id/board/notes/:nid', (c) => {
        proj(c.params[0]);
        const title = notes?.title(c.params[1]!);
        if (!notes || title === undefined || !notes.has(c.params[1]!, c.params[0]!)) throw new HttpError(404, 'Unknown note');
        return { id: c.params[1], title };
      });
      add('PUT', '/api/projects/:id/board/leader', (c) => { const p = proj(c.params[0]); const b = body(c); wrap(() => board.setLeader(p, b.leader)); return out(p.id, wrap(() => board.view(proj(p.id)))); });
      add('GET', '/api/projects/:id/board', (c) => wrap(() => board.view(proj(c.params[0]))));
      add('POST', '/api/projects/:id/board/items', (c) => { const p = proj(c.params[0]); return out(p.id, wrap(() => board.create(p, body(c)))); }, 201);
      add('PATCH', '/api/projects/:id/board/items/:iid', (c) => { const p = proj(c.params[0]); return out(p.id, wrap(() => board.patch(p, c.params[1]!, body(c)))); });
      add('POST', '/api/projects/:id/board/items/:iid/move', (c) => { const p = proj(c.params[0]); const b = body(c); return out(p.id, wrap(() => board.move(p, c.params[1]!, b.status, b.index))); });
      add('DELETE', '/api/projects/:id/board/items/:iid', (c) => { const p = proj(c.params[0]); wrap(() => board.remove(p, c.params[1]!)); return out(p.id, { ok: true }); });
      // "Save what we learned": the owner writes a project note about an item (the owner edits the text first in the app); it is linked to the item
      add('POST', '/api/projects/:id/board/items/:iid/note', (c) => {
        const p = proj(c.params[0]);
        if (!notes) throw new HttpError(409, 'The Library is not available in this core.');
        if (p.status === 'archived') throw new HttpError(409, 'This project is archived: unarchive it to save a note.');
        const b = body(c);
        const item = wrap(() => board.get(p.id, c.params[1]!));
        if (!item || item.proposal) throw new HttpError(404, 'Unknown item');
        if (typeof b.title !== 'string' || !b.title.trim() || typeof b.body !== 'string' || !b.body.trim()) throw new HttpError(400, 'title and body are required');
        let made: { id: string; title: string };
        try { made = notes.create(p.id, { title: b.title.trim().slice(0, 120), body: b.body.slice(0, 4000), itemId: item.id }); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'The Library refused the note'); }
        const next = wrap(() => board.linkNotes(p.id, item.id, [made.id], { kind: 'owner' }));
        return out(p.id, { item: next, note: made });
      }, 201);
      add('POST', '/api/projects/:id/board/items/:iid/accept', (c) => { const p = proj(c.params[0]); const b = isObj(c.body) ? c.body : {}; return out(p.id, wrap(() => board.accept(p, c.params[1]!, b))); });
      add('POST', '/api/projects/:id/board/items/:iid/reject', (c) => { const p = proj(c.params[0]); wrap(() => board.reject(p, c.params[1]!)); return out(p.id, { ok: true }); });
      add('POST', '/api/projects/:id/board/items/:iid/run', (c) => {
        const p = proj(c.params[0]);
        if (p.status === 'archived') throw new HttpError(409, 'This project is archived: unarchive it to run an item.');
        const item: WorkItem | undefined = wrap(() => board.get(p.id, c.params[1]!));
        if (!item || item.proposal) throw new HttpError(404, 'Unknown item');
        if (item.assignee?.kind !== 'agent') throw new HttpError(400, 'Assign this item to a member agent first: the owner cannot "run" an item.');
        const agentId = item.assignee.id;
        if (!p.members.includes(agentId)) throw new HttpError(400, `${agentId} is not a member of this project. Reassign the item or add the agent as a member.`);
        if (item.activeRun) {
          const t = deps.store.getTask(item.activeRun);
          if (t && (t.status === 'queued' || t.status === 'running')) throw new HttpError(409, 'This item already has a run in progress.');
        }
        const untrusted = item.trust !== 'human';
        // the owner's click, through the ordinary project run path: same approvals, same cost; text nobody has read runs under the `ask` ceiling and tainted
        const task = deps.engine.startTask({
          agentId, prompt: runPrompt(item), source: 'ui', projectId: p.id,
          ...(untrusted ? { origin: { ...UNTRUSTED_ORIGIN }, tainted: true } : {}),
        });
        const next = wrap(() => board.beginRun(p, item.id, task.id));
        changed(p.id);
        return { item: next, task, limited: untrusted };
      }, 201);
    },
  };
}
