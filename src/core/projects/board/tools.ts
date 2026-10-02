/**
 * In-process SDK MCP server "legion_board": the bot-facing board tools (list, get, propose, update_own).
 * The project is the engine's (ModuleJob.projectId); no tool takes a project argument. Handlers never throw.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BOARD_STATUSES } from '../../../shared/board.js';
import type { ModuleJob } from '../../modules.js';
import type { ProjectStore } from '../store.js';
import { DATA_NOTE, itemForBot } from './prompt.js';
import { BoardError } from './store.js';
import type { BoardStore } from './store.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const json = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

export function buildBoardToolsServer(agentId: string, deps: { board: BoardStore; projects: ProjectStore; onChange?: (projectId: string) => void }, job: Pick<ModuleJob, 'projectId' | 'taskId' | 'taint' | 'origin'>): McpSdkServerConfigWithInstance {
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
  const propose = tool('propose', 'Propose a new work item. It waits in the owner\'s Inbox and nothing starts; the owner decides. Limited in number and rate. Never put secrets in it.',
    {
      title: z.string(), description: z.string().optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
      labels: z.array(z.string()).optional().describe('At most 5 short labels.'), suggestedAssignee: z.string().optional().describe('A member agent id; the owner decides.'),
    },
    async (a) => guard(() => {
      const p = scope();
      const i = deps.board.propose(p, agentId, a, { tainted: job.taint() });
      deps.onChange?.(p.id);
      return json({ proposed: true, id: i.id, note: 'It is in the owner\'s Inbox. You cannot start it or change it; the owner may accept, edit or reject it.' });
    }));
  const updateOwn = tool('update_own', 'On an item assigned to you: set the status to doing, review or blocked and/or add a short note (what you did, what is left). You cannot mark it done, edit it, reassign or delete it.',
    { id: z.string(), status: z.enum(['doing', 'review', 'blocked']).optional(), note: z.string().optional() },
    async (a) => guard(() => {
      const p = scope();
      const i = deps.board.botUpdate(p, agentId, a.id, a, runInfo());
      deps.onChange?.(p.id);
      return json({ updated: true, id: i.id, status: i.status });
    }));
  return createSdkMcpServer({ name: 'legion_board', version: '0.1.0', tools: [list, get, propose, updateOwn] });
}
