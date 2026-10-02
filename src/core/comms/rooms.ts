/**
 * Room persistence: <dataDir>/rooms/index.json (atomic), <roomId>.jsonl (append-only messages)
 * and state.json (per-(room,bot) task map, read cursors, round-robin positions).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GUARDS, type Room, type RoomMessage } from '../../shared/comms.js';

export interface TaskMapEntry { taskId: string; lastCost: number }
export interface HubState {
  /** key = `${roomId}|${agentId}` */
  tasks: Record<string, TaskMapEntry>;
  /** key = `${roomId}|${agentId}` -> id of the last message the agent has seen */
  reads: Record<string, string>;
  /** roomId -> next round-robin index */
  rr: Record<string, number>;
}

const emptyState = (): HubState => ({ tasks: {}, reads: {}, rr: {} });

function writeAtomic(file: string, data: string): void {
  const tmp = file + '.tmp';
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

/** Room ids only ever come from this store, but keep file names inert regardless. */
const fileSafe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/g, '_');

export class RoomStore {
  readonly dir: string;
  private readonly rooms = new Map<string, Room>();
  private readonly msgs = new Map<string, RoomMessage[]>();
  private readonly indexFile: string;
  private readonly stateFile: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'rooms');
    mkdirSync(this.dir, { recursive: true });
    this.indexFile = join(this.dir, 'index.json');
    this.stateFile = join(this.dir, 'state.json');
    const idx = this.readJson<unknown>(this.indexFile, []);
    for (const r of Array.isArray(idx) ? (idx as Room[]) : []) {
      if (!r || typeof r.id !== 'string') continue;
      // A stored number keeps its value and null means "no spend limit"; only a missing or junk budget falls back to the default.
      const b = r.guards?.budgetUsd as unknown;
      if (r.guards && b !== null && !(typeof b === 'number' && Number.isFinite(b))) r.guards = { ...r.guards, budgetUsd: DEFAULT_GUARDS.budgetUsd };
      this.rooms.set(r.id, r);
    }
  }

  /** Internal (mutable) room objects, newest activity first. */
  all(): Room[] {
    return [...this.rooms.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
  get(id: string): Room | undefined { return this.rooms.get(id); }

  save(room: Room): void {
    this.rooms.set(room.id, room);
    this.writeIndex();
  }

  remove(id: string): void {
    this.rooms.delete(id);
    this.msgs.delete(id);
    this.writeIndex();
    try { unlinkSync(this.msgFile(id)); } catch { /* already gone */ }
  }

  messages(roomId: string): readonly RoomMessage[] {
    let list = this.msgs.get(roomId);
    if (list) return list;
    list = [];
    const f = this.msgFile(roomId);
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { list.push(JSON.parse(line) as RoomMessage); } catch { /* skip torn line */ }
      }
    }
    this.msgs.set(roomId, list);
    return list;
  }

  append(msg: RoomMessage): void {
    const list = this.messages(msg.roomId) as RoomMessage[];
    list.push(msg);
    appendFileSync(this.msgFile(msg.roomId), JSON.stringify(msg) + '\n', 'utf8');
  }

  loadState(): HubState {
    const s = this.readJson<Partial<HubState>>(this.stateFile, {});
    return { ...emptyState(), tasks: s.tasks ?? {}, reads: s.reads ?? {}, rr: s.rr ?? {} };
  }
  saveState(state: HubState): void {
    try { writeAtomic(this.stateFile, JSON.stringify(state)); } catch { /* best effort */ }
  }

  private writeIndex(): void {
    writeAtomic(this.indexFile, JSON.stringify([...this.rooms.values()], null, 2));
  }

  private msgFile(roomId: string): string { return join(this.dir, `${fileSafe(roomId)}.jsonl`); }

  private readJson<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return fallback;
    }
  }
}
