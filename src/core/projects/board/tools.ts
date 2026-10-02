/**
 * In-process SDK MCP server "legion_board": the bot-facing board tools (list, get, propose, create, update, delete for the leader).
 * The project is the engine's (ModuleJob.projectId); no tool takes a project argument. Handlers never throw.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BOARD_STATUSES, BOT_STATUSES } from '../../../shared/board.js';
import type { ModuleJob } from '../../modules.js';
import type { ProjectStore } from '../store.js';
import { cardText } from '../../comms/scrub.js';
import { DATA_NOTE, itemForBot } from './prompt.js';
import { BoardError } from './store.js';
import type { BoardStore } from './store.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const json = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** `askOwner` shows the owner an approval card and resolves with the answer (false: declined or no answer). */
export type AskOwner = (r: { taskId: string; agentId: string; tool: string; summary: string; input: Record<string, unknown>; origin?: ModuleJob['origin'] }) => Promise<boolean>;

export function buildBoardToolsServer(agentId: string, deps: { board: BoardStore; projects: ProjectStore; onChange?: (projectId: string) => void; askOwner?: AskOwner }, job: Pick<ModuleJob, 'projectId' | 'taskId' | 'taint' | 'origin'>): McpSdkServerConfigWithInstance {
  /** The run's project, looked up again at every call (archive and membership changes apply at once). */
  const scope = () => {
    const p = deps.projects.forRun(job.projectId, agentId);
    if (!p) throw new BoardError(403, 'This run is not part of an active project you belong to, so there is no board for you.');
    return p;
  };
  const guard = (fn: () => ToolResult): ToolResult => { try { return fn(); } catch (e) { return fail(e); } };
  const runInfo = () => ({ taskId: job.taskId, tainted: job.taint(), ...(job.origin?.roomId ? { roomId: job.origin.roomId } : {}) });

  const list = tool('list', 'List the work items of this project\'s board (id, title, status, priority, assignee, due, labels). Items assigned to you are marked.',
    { status: z.enum(BOARD_STATUSES).optional() },
    async (a) => guard(() => {
      const p = scope();
      const v = deps.board.view(p);
      return json({ note: DATA_NOTE, items: v.items.filter((i) => !a.status || i.status === a.status).map((i) => itemForBot(i, agentId, false)), yourPendingProposals: v.inbox.filter((i) => i.createdBy.kind === 'agent' && i.createdBy.id === agentId).length });
    }));
  const get = tool('get', 'Read one work item of this project: description and the latest activity.', { id: z.string() },
    async (a) => guard(() => {
      const p = scope();
      const i = deps.board.get(p.id, a.id);
      if (!i || i.proposal) throw new BoardError(404, `Unknown item "${a.id.slice(0, 40)}".`);
      return json({ note: DATA_NOTE, item: itemForBot(i, agentId, true) });
    }));
  const priorityEnum = z.enum(['low', 'normal', 'high']);
  const labelsArg = z.array(z.string()).optional().describe('At most 5 short labels.');
  const propose = tool('propose', 'Suggest a new work item for the owner to review. It waits in the owner\'s Inbox and is not on the board until the owner accepts it. Use create instead when the item is plainly part of your work. Never put secrets in it.',
    {
      title: z.string(), description: z.string().optional(), priority: priorityEnum.optional(), labels: labelsArg, suggestedAssignee: z.string().optional().describe('A member agent id; the owner decides.'),
    },
    async (a) => guard(() => {
      const p = scope();
      const i = deps.board.propose(p, agentId, a, { tainted: job.taint() });
      deps.onChange?.(p.id);
      return json({ proposed: true, id: i.id, note: 'It is in the owner\'s Inbox. You cannot start it or change it; the owner may accept, edit or reject it.' });
    }));
  const create = tool('create', 'Create a work item on the board (backlog, doing, review or blocked). You may assign it to a member agent (not to the owner). Text you write is marked as an agent\'s, so the owner reviews it before a run on it gets full permissions. Limited in number and rate. Never put secrets in it.',
    {
      title: z.string(), description: z.string().optional(), status: z.enum(BOT_STATUSES).optional(), priority: priorityEnum.optional(), labels: labelsArg,
      due: z.string().optional().describe('YYYY-MM-DD'), assignee: z.string().optional().describe('A member agent id.'),
    },
    async (a) => guard(() => {
      const p = scope();
      const { assignee, ...rest } = a;
      const i = deps.board.botCreate(p, agentId, { ...rest, ...(assignee !== undefined ? { assignee: { kind: 'agent', id: assignee } } : {}) }, { tainted: job.taint() });
      deps.onChange?.(p.id);
      return json({ created: true, id: i.id, status: i.status });
    }));
  const update = tool('update', 'Change a work item of this project: title, description, priority, labels, due date, status (backlog, doing, review, blocked; never done), position in its column, assignee (a member agent or null; not the owner), and/or add a short note (what you did, what is left). Items assigned to the owner take notes only; done items are closed. Editing the text marks the item as not reviewed by the owner.',
    {
      id: z.string(), note: z.string().optional(), status: z.enum(BOT_STATUSES).optional(), index: z.number().int().optional().describe('Position in the column, 0 = top.'),
      title: z.string().optional(), description: z.string().optional(), priority: priorityEnum.optional(), labels: labelsArg,
      due: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear.'), assignee: z.string().nullable().optional().describe('A member agent id, or null to unassign.'),
    },
    async (a) => guard(() => {
      const p = scope();
      const { id, assignee, ...rest } = a;
      const i = deps.board.botUpdate(p, agentId, id, { ...rest, ...(assignee !== undefined ? { assignee: assignee === null ? null : { kind: 'agent', id: assignee } } : {}) }, runInfo());
      deps.onChange?.(p.id);
      return json({ updated: true, id: i.id, status: i.status });
    }));
  const del = tool('delete', 'Delete a work item. Only the project\'s board leader has this tool, and the owner sees an approval card for every delete: nothing is deleted unless they allow it. Not for done items or items assigned to the owner. If it is declined, do not ask again.',
    { id: z.string() },
    async (a) => {
      try {
        const p = scope();
        const item = deps.board.checkBotDelete(p, agentId, a.id, { tainted: job.taint() }, true);
        if (!deps.askOwner || !job.taskId) throw new BoardError(409, 'There is no way to ask the owner from here, so nothing was deleted.');
        const summary = `${cardText(agentId, 40)} wants to delete the work item "${cardText(item.title, 80)}" from project "${cardText(p.name ?? p.id, 60)}". It will be gone for good.`;
        const allowed = await deps.askOwner({ taskId: job.taskId, agentId, tool: 'delete', summary, input: { id: item.id }, ...(job.origin ? { origin: job.origin } : {}) });
        if (!allowed) throw new BoardError(409, 'The owner did not approve this (declined, or no answer in time). Nothing was deleted. Do not ask again unless the owner says so.');
        deps.board.botDelete(p, agentId, a.id, { tainted: job.taint() });
        deps.onChange?.(p.id);
        return json({ deleted: true, id: item.id });
      } catch (e) { return fail(e); }
    });
  const isLeader = (): boolean => { const p = deps.projects.forRun(job.projectId, agentId); return !!p && deps.board.leaderOf(p) === agentId; };
  return createSdkMcpServer({ name: 'legion_board', version: '0.2.0', tools: [list, get, propose, create, update, ...(isLeader() ? [del] : [])] });
}
