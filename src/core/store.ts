/** Persistent state in JSON files. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProfile, ChatMessage, Task, VmRecord } from '../shared/types.js';
import { nowIso } from '../shared/util.js';
import { ROSTER } from './roster.js';

interface StateFile { agents: AgentProfile[]; tasks: Task[]; vms: VmRecord[] }

const DEBOUNCE_MS = 200;

export class Store {
  private agents = new Map<string, AgentProfile>();
  private tasks = new Map<string, Task>();
  private vms = new Map<string, VmRecord>();
  private messages = new Map<string, ChatMessage[]>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly stateFile: string;
  private readonly messagesDir: string;

  /** dir = data dir (e.g. ~/.legion). Loads <dir>/state.json if present. Writes are debounced (~200ms), atomic (tmp + rename). */
  constructor(public readonly dir: string) {
    this.stateFile = join(dir, 'state.json');
    this.messagesDir = join(dir, 'messages');
    mkdirSync(dir, { recursive: true });
    if (existsSync(this.stateFile)) {
      try {
        const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<StateFile>;
        for (const a of s.agents ?? []) this.agents.set(a.id, a);
        for (const t of s.tasks ?? []) this.tasks.set(t.id, t);
        for (const v of s.vms ?? []) this.vms.set(v.agentId, v);
      } catch {
        // Corrupt state file: keep a backup and start fresh rather than crash.
        try { renameSync(this.stateFile, this.stateFile + '.corrupt-' + Date.now()); } catch { /* ignore */ }
      }
    }
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
  getTask(id: string): Task | undefined { return this.tasks.get(id); }
  upsertTask(t: Task): Task { this.tasks.set(t.id, t); this.markDirty(); return t; }
  /** Removes the task and its messages file. Returns false if unknown. */
  deleteTask(id: string): boolean {
    const had = this.tasks.delete(id);
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
        systemPrompt: 'You are the lead agent. Handle general requests directly and keep answers concise.\nFor big or specialised work, break it into steps and suggest delegating to Builder (coding) or Scout (research).\nUse your cloud VM only when the task really needs it.',
        vm: { enabled: true, size: 'default', idleStopMinutes: 15 }, mcpServers: ['*'],
      },
      {
        id: 'builder', name: 'Builder', emoji: '⌘', model: 'auto', approval: 'full',
        description: 'Coding and building; prefers its VM for risky work.',
        systemPrompt: 'You write, run and debug code. Make small, verifiable changes and run tests before reporting done.\nPrefer your cloud VM for untrusted code, heavy installs, long builds and GUI/browser work.\nStop the VM when you are finished with it.',
        vm: { enabled: true, size: 'large', idleStopMinutes: 15 }, mcpServers: ['*'],
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
    this.timer = setTimeout(() => { this.timer = null; this.schedulePersist(); }, DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private schedulePersist(): void {
    this.dirty = false;
    const data: StateFile = { agents: this.listAgents(), tasks: [...this.tasks.values()], vms: this.listVms() };
    const json = JSON.stringify(data, null, 2);
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
