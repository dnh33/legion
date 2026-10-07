/** Persistent state in JSON files. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProfile, ChatMessage, Task, VmRecord } from '../shared/types.js';
import { nowIso } from '../shared/util.js';
import { ROSTER } from './roster.js';
import { TaskIndex, type PageQuery } from './task-index.js';

interface StateFile { agents: AgentProfile[]; tasks: Task[]; vms: VmRecord[]; /** One-time migrations already applied (see MIGRATIONS). Absent in files from older builds. */ migrations?: string[] }

/** Zealot's first seeded prompt: it told the lead to handle requests itself, the opposite of its role. */
const ZEALOT_OLD_PROMPT = 'You are the lead agent. Handle general requests directly and keep answers concise.\nFor big or specialised work, break it into steps and suggest delegating to Builder (coding) or Scout (research).\nUse your cloud VM only when the task really needs it.';
/** Zealot's seeded prompt. Its role is also enforced by the lead doctrine the engine appends last (src/core/lead.ts). */
export const ZEALOT_PROMPT = 'You are the lead of the Order. Every request comes to you first: you plan it, split it into tasks and hand them to the agents best placed for them, and you keep the person informed. Keep your answers concise.\nUse your cloud VM only when the task really needs it.';

/** Applied once per state file, in order, then recorded in `migrations` so they never run again (and never undo a later manual choice). */
const MIGRATIONS: Array<{ id: string; run: (agents: Map<string, AgentProfile>) => boolean }> = [
  {
    // Builder used to be seeded with VM size 'large', which free boat.dev trials refuse. Reset it to 'default' once; the user can pick 'large' again.
    id: 'builder-vm-size-default-v1',
    run: (agents) => {
      const b = agents.get('builder');
      if (!b || b.vm?.size !== 'large') return false;
      b.vm = { ...b.vm, size: 'default' };
      return true;
    },
  },
  {
    // Zealot's seeded prompt contradicted its role (owner 2026-10-05). Replaced ONLY while it is still that exact old seed:
    // a prompt the person wrote is never touched (the lead doctrine still applies to it, appended last by the engine).
    id: 'zealot-lead-prompt-v1',
    run: (agents) => {
      const z = agents.get('zealot');
      if (!z || z.systemPrompt !== ZEALOT_OLD_PROMPT) return false;
      z.systemPrompt = ZEALOT_PROMPT;
      return true;
    },
  },
];

const DEBOUNCE_MS = 200;

export class Store {
  private agents = new Map<string, AgentProfile>();
  private tasks = new Map<string, Task>();
  private vms = new Map<string, VmRecord>();
  private messages = new Map<string, ChatMessage[]>();
  private index = new TaskIndex();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private migrations = new Set<string>();
  private readonly stateFile: string;
  private readonly messagesDir: string;
  private readonly saveDebounceMs: number;

  /** dir = data dir (e.g. ~/.legion). Loads <dir>/state.json if present. Writes are debounced (~200ms), atomic (tmp + rename). */
  constructor(public readonly dir: string, options?: { saveDebounceMs?: number }) {
    this.saveDebounceMs = options?.saveDebounceMs ?? DEBOUNCE_MS;
    this.stateFile = join(dir, 'state.json');
    this.messagesDir = join(dir, 'messages');
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.stateFile)) {
      try {
        const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<StateFile>;
        for (const a of s.agents ?? []) this.agents.set(a.id, a);
        for (const t of s.tasks ?? []) this.tasks.set(t.id, t);
        for (const v of s.vms ?? []) this.vms.set(v.agentId, v);
        for (const m of Array.isArray(s.migrations) ? s.migrations : []) if (typeof m === 'string') this.migrations.add(m);
      } catch {
        // Corrupt state file: keep a backup and start fresh rather than crash.
        try { renameSync(this.stateFile, this.stateFile + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
    }
    this.migrate();
    this.index.rebuild(this.tasks.values());
  }

  /** Runs each migration that this state file has not recorded yet. A fresh install records them all without changing anything. */
  private migrate(): void {
    let changed = false;
    for (const m of MIGRATIONS) {
      if (this.migrations.has(m.id)) continue;
      if (m.run(this.agents)) changed = true;
      this.migrations.add(m.id);
      changed = true;
    }
    if (changed) this.markDirty();
  }

  listAgents(): AgentProfile[] { return [...this.agents.values()]; }
  getAgent(id: string): AgentProfile | undefined { return this.agents.get(id); }
  upsertAgent(a: AgentProfile): AgentProfile { this.agents.set(a.id, a); this.markDirty(); return a; }
  deleteAgent(id: string): boolean {
    const had = this.agents.delete(id);
    if (had) { this.vms.delete(id); this.markDirty(); }
    return had;
  }

  /** Newest first (by updatedAt). */
  listTasks(limit = 200, agentId?: string, includeArchived = false): Task[] {
    let list = [...this.tasks.values()];
    if (!includeArchived) list = list.filter((t) => !t.archived);
    if (agentId) list = list.filter((t) => t.agentId === agentId);
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return list.slice(0, limit);
  }
  /**
   * One page of tasks, newest first (updatedAt desc, id desc), from the in-memory index (src/core/task-index.ts): no scan or sort of the history.
   * Filtering by agent visibility, project, archived flag and search text happens inside the walk, so the page is always full when more exist.
   */
  pageTasks(q: PageQuery): { tasks: Task[]; nextCursor: string | null } {
    const { ids, nextCursor } = this.index.page(q);
    return { tasks: ids.map((id) => this.tasks.get(id)).filter((t): t is Task => !!t), nextCursor };
  }
  /** The tasks a window needs at once: every queued or running one, plus per agent the newest `perAgent` by creation and by update, plus the newest `recent` overall. Newest first by updatedAt. */
  snapshotTasks(o: { agentIds: readonly string[]; perAgent: number; recent: number; includeArchived: boolean; agentOk?: (agentId: string) => boolean }): Task[] {
    const ids = new Set<string>(this.index.liveIds());
    for (const a of o.agentIds) {
      for (const by of ['createdAt', 'updatedAt'] as const) for (const id of this.index.newest(o.perAgent, { agentId: a, by, includeArchived: o.includeArchived })) ids.add(id);
    }
    for (const id of this.index.newest(o.recent, { by: 'updatedAt', includeArchived: o.includeArchived, ...(o.agentOk ? { agentOk: o.agentOk } : {}) })) ids.add(id);
    const out = [...ids].map((id) => this.tasks.get(id)).filter((t): t is Task => !!t && (!o.agentOk || o.agentOk(t.agentId)));
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
  getTask(id: string): Task | undefined { return this.tasks.get(id); }
  upsertTask(t: Task): Task { this.tasks.set(t.id, t); this.index.set(t); this.markDirty(); return t; }
  /** Removes the task and its messages file. Returns false if unknown. */
  deleteTask(id: string): boolean {
    const had = this.tasks.delete(id);
    this.index.remove(id);
    this.messages.delete(id);
    try { rmSync(this.msgFile(id), { force: true }); } catch { /* ignore */ }
    if (had) this.markDirty();
    return had;
  }

  /** Messages live in <dir>/messages/<taskId>.jsonl (append-only). */
  listMessages(taskId: string): ChatMessage[] {
    return [...this.loadMessages(taskId)];
  }
  addMessage(m: ChatMessage): ChatMessage {
    const list = this.loadMessages(m.taskId);
    list.push(m);
    mkdirSync(this.messagesDir, { recursive: true });
    appendFileSync(this.msgFile(m.taskId), JSON.stringify(m) + '\n', 'utf8');
    return m;
  }

  listVms(): VmRecord[] { return [...this.vms.values()]; }
  /** Returns a default {state:'none', sandboxId:null,...} record (size from agent or 'default') if none stored. */
  getVm(agentId: string): VmRecord {
    const v = this.vms.get(agentId);
    if (v) return v;
    return {
      agentId, sandboxId: null, state: 'none',
      size: this.agents.get(agentId)?.vm.size ?? 'default',
      lastUsedAt: null, createdAt: null,
    };
  }
  upsertVm(v: VmRecord): VmRecord { this.vms.set(v.agentId, v); this.markDirty(); return v; }

  /** Ensure the default agents (see docs/ARCHITECTURE.md) exist without overwriting edits. */
  seedDefaults(workspaceDir: string): void {
    const ts = nowIso();
    const defs: Array<Omit<AgentProfile, 'createdAt' | 'updatedAt' | 'cwd'>> = [
      {
        id: 'zealot', name: 'Zealot', emoji: '✠', model: 'auto', approval: 'auto-edits',
        description: 'Lead agent of the Legion: takes any request, delegates to the order.',
        systemPrompt: ZEALOT_PROMPT,
        vm: { enabled: true, size: 'default', idleStopMinutes: 15 }, mcpServers: ['*'],
      },
      {
        id: 'builder', name: 'Builder', emoji: '⌘', model: 'auto', approval: 'full',
        description: 'Coding and building; prefers its VM for risky work.',
        systemPrompt: 'You write, run and debug code. Make small, verifiable changes and run tests before reporting done.\nPrefer your cloud VM for untrusted code, heavy installs, long builds and GUI/browser work.\nStop the VM when you are finished with it.',
        vm: { enabled: true, size: 'default', idleStopMinutes: 15 }, mcpServers: ['*'], // 'large' only when the user picks it: free trials refuse it
      },
      {
        id: 'scout', name: 'Scout', emoji: '◎', model: 'sonnet', approval: 'ask',
        description: 'Research, reading and summarising.',
        systemPrompt: 'You research, read and summarise. Cite sources and separate facts from guesses.\nKeep summaries tight: lead with the answer, then supporting detail.\nDo not modify files unless explicitly asked.',
        vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, mcpServers: ['*'],
      },
    ];
    // Muster roster (src/core/roster.ts). Cloned so stored agents never share objects with the constants.
    defs.push(...ROSTER.map((r) => ({ ...r, vm: { ...r.vm }, mcpServers: [...r.mcpServers] })));
    let changed = false;
    for (const d of defs) {
      if (this.agents.has(d.id)) continue;
      this.agents.set(d.id, { ...d, cwd: join(workspaceDir, d.id), createdAt: ts, updatedAt: ts });
      changed = true;
    }
    if (changed) this.markDirty();
  }

  /** On startup: any task left 'running'/'queued' from a previous process becomes 'error' ("Legion restarted"). */
  recoverInterrupted(): number {
    let n = 0;
    const ts = nowIso();
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'error';
        t.error = 'Legion restarted';
        t.updatedAt = ts;
        this.index.set(t);
        n++;
      }
    }
    if (n) this.markDirty();
    return n;
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) this.schedulePersist();
    await this.writing;
  }

  // ---- internals ----
  private msgFile(taskId: string): string { return join(this.messagesDir, `${taskId.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`); }

  private loadMessages(taskId: string): ChatMessage[] {
    let list = this.messages.get(taskId);
    if (list) return list;
    list = [];
    const f = this.msgFile(taskId);
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { list.push(JSON.parse(line) as ChatMessage); } catch { /* skip torn line */ }
      }
    }
    this.messages.set(taskId, list);
    return list;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.schedulePersist(); }, this.saveDebounceMs);
    this.timer.unref?.();
  }

  private schedulePersist(): void {
    this.dirty = false;
    const data: StateFile = { agents: this.listAgents(), tasks: [...this.tasks.values()], vms: this.listVms(), migrations: [...this.migrations] };
    const json = JSON.stringify(data); // compact: the file is machine-written (pretty printing 3000 tasks cost 35 ms and 2x the bytes)
    this.writing = this.writing.then(() => this.writeAtomic(json)).catch(() => { /* best effort */ });
  }

  private async writeAtomic(json: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    await writeFile(tmp, json, 'utf8');
    try {
      await rename(tmp, this.stateFile);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST') {
        await unlink(this.stateFile).catch(() => undefined);
        await rename(tmp, this.stateFile);
      } else throw e;
    }
  }
}
