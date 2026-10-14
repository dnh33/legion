/**
 * Project board module (a feature, on by default: built unless its feature switch in config.json is false).
 * Owner routes are admin-only by the gate's default deny. The board never executes anything by itself; "Run this item" is the owner's click.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { BOARD_LIMITS } from '../../../shared/board.js';
import type { BoardMarshalStatus, WorkItem } from '../../../shared/board.js';
import type { Project } from '../../../shared/projects.js';
import type { TaskOrigin } from '../../../shared/comms.js';
import type { CoreModule, ModuleDeps } from '../../modules.js';
import { HttpError } from '../../server.js';
import type { Ctx } from '../../server.js';
import { agentIdVisible } from '../../visibility.js';
import { engineMatcher } from '../../marshal/matcher.js';
import { MarshalDriver } from '../../marshal/driver.js';
import { MAX_DONE_WHEN } from '../../marshal/ledger.js';
import type { MarshalPorts, RunState } from '../../marshal/orchestrator.js';
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

export interface BoardModuleOpts {
  projects: ProjectStore;
  board: BoardStore;
  /** The project Library (absent in tests that do not need it): note links, automatic linking and "save what we learned". */
  notes?: BoardNotes;
  /** The away module: "Pause new starts" stops the Marshal's loop for a paused project. Absent: never paused. */
  away?: { isPaused(projectId: string): boolean };
  /** The Marshal's clock. The app takes Date.now; a test passes its own. */
  marshalNow?: () => number;
  /** The Marshal's timer: starts the tick and returns the cancel function. Tests pass a no-op and call `module.marshal.tick()` themselves. */
  marshalSchedule?: (fn: () => void, ms: number) => () => void;
}
/** The board module plus the Marshal's per-project driver — what the three marshal routes drive and what `dispose` stops. */
export interface BoardModule extends CoreModule { marshal: MarshalDriver }

/** The checks that decide an item (`doneWhen`): the ledger's own bound, each a line of text. */
const doneWhen = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new HttpError(400, 'doneWhen must be an array of checks (one line each)');
  if (v.length > MAX_DONE_WHEN) throw new HttpError(400, `at most ${MAX_DONE_WHEN} checks: they are what decides whether this item is done`);
  return v.map((raw, n) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, `check ${n + 1} must be text`);
    const one = raw.trim();
    if (one.length > 200) throw new HttpError(400, `check ${n + 1} is too long (max 200 characters)`);
    return one;
  });
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The approval ceiling of a run on text no human has read: the same as a token client's run. */
const UNTRUSTED_ORIGIN: TaskOrigin = { roomId: 'board', fromAgentId: 'board', hop: 0, approvalCeiling: 'ask', tainted: true };

/** When a board run last showed life: its task row or its newest message, whichever is later (D1: a busy run is not a stalled one). */
export function runProgressAt(task: { updatedAt: string }, lastMessages: ReadonlyArray<{ at: string }>): number {
  let best = Date.parse(task.updatedAt);
  for (const m of lastMessages) { const at = Date.parse(m.at); if (Number.isFinite(at) && !(at <= best)) best = at; }
  return best;
}

export function createBoardModule(deps: ModuleDeps, opts: BoardModuleOpts): BoardModule {
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
  // a run is live while its task is queued or running; an unreadable task store counts as live (never end a run on a guess)
  board.setRunLookup((taskId) => {
    const t = deps.store.getTask(taskId);
    return { live: !!t && (t.status === 'queued' || t.status === 'running'), ...(t?.agentId ? { agentId: t.agentId } : {}), ...(t ? { tainted: !!t.tainted } : {}) };
  });
  // the engine marked tasks left running by a previous process as errors before the modules were built: end their items' runs now
  // per project, so one unreadable board does not leave the others' items stuck in Doing
  let all: { id: string }[] = [];
  try { all = projects.list(); } catch { /* the board still starts */ }
  for (const p of all) { try { board.reconcileRuns(p.id); } catch { /* this project's items stay as they were */ } }

  // ---- the Marshal (C2/C3): the loop over this core's own engine, store and matcher --------------
  // The run port carries NO model. `engine.startTask({ agentId, prompt, source: 'ui', projectId })` asked for
  // no model at all resolves to the bot's own chosen setting, so a dispatch structurally cannot reroute where
  // a run runs — the port has no slot to put a model in.
  const matcher = engineMatcher({ engine: deps.engine, bus: deps.bus, store: deps.store, canRunIn: (pid, agentId) => !!projects.forRun(pid, agentId) });
  const portsFor = (pid: string): MarshalPorts => ({
    board,
    agents: () => deps.store.listAgents(),
    visible: (id) => agentIdVisible({ bsvEnabled: deps.bsvEnabled, store: deps.store }, id),
    matcher,
    startRun: ({ agentId, prompt }) => ({ taskId: deps.engine.startTask({ agentId, prompt, source: 'ui', projectId: pid, trigger: 'marshal' }).id }),
    runState: (taskId): RunState => {
      try {
        const t = deps.store.getTask(taskId);
        if (!t) return { status: 'unknown' };
        // the task row changes only at a few points of a run: its newest message (a tool call, a reply) is the real sign of life
        // the extra signs of life are best effort: they can never hide the run's real status
        let last: Array<{ at: string }> = [];
        try { last = deps.store.listMessages(taskId).slice(-1); } catch { /* the task row still counts */ }
        let waiting = false;
        try { waiting = deps.engine.waitingOnOwner?.(taskId) === true; } catch { /* not waiting */ }
        const at = runProgressAt(t, last);
        return { status: t.status, ...(Number.isFinite(at) ? { progressAt: at } : {}), ...(t.error ? { error: t.error } : {}), ...(waiting ? { waitingOnOwner: true } : {}) };
      } catch {
        // an unreadable task store counts as live, exactly like the board's own run lookup: never end a run on a guess
        return { status: 'running', progressAt: Date.now() };
      }
    },
    cancelRun: (taskId) => deps.engine.cancel(taskId),
    // a bot the owner (or another bot) already has working is busy: the Marshal does not put a second run on it
    botBusy: (id) => {
      try {
        const t = deps.store.listTasks(200, id, true).find((x) => x.status === 'running' || x.status === 'queued');
        if (!t) return false;
        const where = t.projectId ? (projects.get(t.projectId)?.name ?? 'a removed project') : 'no project';
        return `busy in ${where}: ${t.title.length > 60 ? t.title.slice(0, 59) + '…' : t.title}`;
      } catch { return 'busy (its state cannot be read)'; }
    },
  });
  const driver = new MarshalDriver({
    board,
    project: (pid) => { try { return projects.get(pid); } catch { return undefined; } },
    ...(opts.away ? { paused: (pid: string) => opts.away!.isPaused(pid) } : {}),
    ports: portsFor,
    changed,
    now: opts.marshalNow ?? Date.now,
    schedule: opts.marshalSchedule ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return () => clearInterval(t); }),
  });
  // Opt-in across a restart: only a project whose stored config says `enabled` gets a timer. Everything else
  // is off until the owner switches it on through PUT .../board/marshal.
  for (const p of all) {
    try {
      const cfg = board.marshalConfig(p.id);
      if (cfg.enabled) driver.apply(p.id, cfg);
    } catch { /* this project starts as it is */ }
  }

  return {
    id: 'project-board',
    marshal: driver,
    mcpServers: (agent, job): Record<string, McpServerConfig> => {
      // no project (or not an active one this agent belongs to) = no board tool at all
      if (!job?.projectId || !projects.forRun(job.projectId, agent.id)) return {};
      return { legion_board: buildBoardToolsServer(agent.id, { board, projects, onChange: changed, ...(notes ? { notes } : {}), modeOf: (id) => { try { return deps.store?.getAgent(id)?.approval; } catch { return undefined; } }, askOwner: (r) => deps.approvals.request(r.taskId, r.agentId, `mcp__legion_board__${r.tool}`, r.input, r.origin, { summary: r.summary }) }, job, agent.approval) };
    },
    preamble: (agent, ctx) => {
      const p = ctx?.projectId ? projects.forRun(ctx.projectId, agent.id) : undefined;
      if (!p) return '';
      let digest = '';
      try { digest = boardDigest(board.view(p).items, agent.id, (id) => deps.store.getAgent(id)?.name ?? id, undefined, notes?.recent(p.id) ?? [], board.leaderOf(p)); } catch { /* the digest is a convenience */ }
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
      // The Marshal's picture (C2/C3): what runs and why that bot, what is blocked and why, what is next —
      // plus its plain lines, the checks written so far, and the config that switches the loop on for this project.
      // The annotation is the contract: the shared view type is what the window draws, checked here at compile time.
      add('GET', '/api/projects/:id/board/status', (c): BoardMarshalStatus => {
        const p = proj(c.params[0]);
        return wrap(() => ({ ...driver.status(p.id), marshal: board.marshalConfig(p.id) }));
      });
      // The owner's switch. Validated in the store (bounds, a real boolean), applied to the live driver at once.
      add('PUT', '/api/projects/:id/board/marshal', (c) => {
        const p = proj(c.params[0]);
        const cfg = wrap(() => board.setMarshal(p, body(c)));
        driver.apply(p.id, cfg);
        changed(p.id);
        return cfg;
      });
      add('POST', '/api/projects/:id/board/items', (c) => { const p = proj(c.params[0]); return out(p.id, wrap(() => board.create(p, body(c)))); }, 201);
      add('PATCH', '/api/projects/:id/board/items/:iid', (c) => { const p = proj(c.params[0]); return out(p.id, wrap(() => board.patch(p, c.params[1]!, body(c)))); });
      // The checks that decide an item (done_when): written before the first dispatch, shown next to the item.
      add('PUT', '/api/projects/:id/board/items/:iid/dispatch', (c) => {
        const p = proj(c.params[0]);
        if (p.status === 'archived') throw new HttpError(409, 'This project is archived: its board is read-only. Unarchive it first.');
        const checks = doneWhen(body(c).doneWhen);
        const item: WorkItem | undefined = wrap(() => board.get(p.id, c.params[1]!));
        if (!item || item.proposal) throw new HttpError(404, 'Unknown item');
        const marshal = driver.marshalFor(p.id);
        if (!marshal) throw new HttpError(404, `Unknown project "${p.id}"`);
        marshal.writeDoneWhen(item.id, checks);
        changed(p.id);
        return { itemId: item.id, doneWhen: marshal.ledger.doneWhen(item.id) ?? [] };
      });
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
        if (item.status === 'done') throw new HttpError(409, 'This item is Done. Move it out of Done to run it again.');
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
    // the loop's timers stop with the core; the Marshals and their ledgers are just objects
    dispose: () => driver.dispose(),
  };
}
