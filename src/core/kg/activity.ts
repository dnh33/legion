/**
 * The Activity list: what bots (and the system) wrote lately, each with the ops that undo it. Kept in its own small
 * file next to the graph log, for 7 days and at most 500 entries. It is not an audit log: nothing here is needed to
 * load the graph, a damaged line is skipped, and entries simply age out.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { KgNodeType, KgTrust } from '../../shared/kg.js';

export const ACTIVITY_DAYS = 7;
const MAX_ENTRIES = 500;
/** The file may run this many lines past MAX_ENTRIES before it is rewritten, so a steady stream of writes appends in chunks instead of rewriting the whole file each time. */
const TRIM_CHUNK = 100;
/** An entry whose undo data is bigger than this is kept in the list but cannot be undone. */
const MAX_INVERSE_BYTES = 64 * 1024;
const REWRITE_BYTES = 4 * 1024 * 1024;
const DAY = 86_400_000;

/** One line of the graph log (node, edge, patch, del_node, del_edge). */
export type LogOp = { op: string; [k: string]: unknown };

export interface ActivityEntry {
  id: string;
  at: string;
  /** Agent id, or 'system'. */
  who: string;
  taskId?: string;
  via?: string;
  kind: string;
  nodeId?: string;
  nodeType?: KgNodeType;
  title?: string;
  trust?: KgTrust;
  tainted: boolean;
  /** Log ops that put things back as they were, in the order to apply them. Absent: not undoable. */
  inverse?: LogOp[];
  /** Node id -> revision counter right after this write (older entries: the updatedAt string). Undo refuses when a node has changed since. */
  stamps: Record<string, number | string>;
  /** Node id -> fingerprint of the node's links right after this write. Undoing a create refuses when they changed. Absent on older entries. */
  edges?: Record<string, string>;
  undone?: boolean;
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  /** Lines in the file that hold an entry (some may already be trimmed from memory). */
  private fileLines = 0;

  constructor(private readonly file: string, private readonly now: () => Date) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let dirty = false;
    let text = '';
    try { text = readFileSync(this.file, 'utf8'); } catch { return; }
    const byId = new Map<string, ActivityEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { a?: string; e?: ActivityEntry; id?: string };
        if (o.a === 'add' && o.e && typeof o.e.id === 'string' && typeof o.e.at === 'string') { byId.set(o.e.id, o.e); this.entries.push(o.e); }
        else if (o.a === 'undo' && typeof o.id === 'string') { const e = byId.get(o.id); if (e) e.undone = true; }
        else dirty = true;
      } catch { dirty = true; }
    }
    if (this.prune() > 0) dirty = true;
    this.fileLines = this.entries.length;
    if (this.entries.length > MAX_ENTRIES) { this.entries = this.entries.slice(-MAX_ENTRIES); dirty = this.fileLines > MAX_ENTRIES + TRIM_CHUNK; }
    if (dirty || statSync(this.file).size > REWRITE_BYTES) this.rewrite();
  }

  private rewrite(): void {
    const body = this.entries.map((e) => JSON.stringify({ a: 'add', e })).join('\n');
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, body ? body + '\n' : '', 'utf8');
      renameSync(tmp, this.file);
      this.fileLines = this.entries.length;
    } catch { rmSync(tmp, { force: true }); }
  }

  add(entry: ActivityEntry): void {
    const e: ActivityEntry = { ...entry };
    if (e.inverse && Buffer.byteLength(JSON.stringify(e.inverse)) > MAX_INVERSE_BYTES) delete e.inverse;
    this.entries.push(e);
    try { appendFileSync(this.file, JSON.stringify({ a: 'add', e }) + '\n', 'utf8'); this.fileLines++; } catch { /* the list is a convenience: losing a line must not fail a write */ }
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    // trim the file in chunks: append for a while, then one rewrite
    if (this.fileLines > MAX_ENTRIES + TRIM_CHUNK) this.rewrite();
  }

  /** Newest first. */
  list(): ActivityEntry[] { return [...this.entries].reverse(); }
  get(id: string): ActivityEntry | undefined { return this.entries.find((e) => e.id === id); }

  isUndoable(e: ActivityEntry): boolean {
    return !e.undone && !!e.inverse && this.now().getTime() - Date.parse(e.at) <= ACTIVITY_DAYS * DAY;
  }

  markUndone(id: string): void {
    const e = this.get(id);
    if (!e) return;
    e.undone = true;
    try { appendFileSync(this.file, JSON.stringify({ a: 'undo', id }) + '\n', 'utf8'); } catch { /* see add() */ }
  }

  /** Drops entries older than the undo window. Returns how many went. */
  prune(): number {
    const cutoff = this.now().getTime() - ACTIVITY_DAYS * DAY;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => Date.parse(e.at) >= cutoff);
    const dropped = before - this.entries.length;
    if (dropped > 0 && existsSync(this.file)) this.rewrite();
    return dropped;
  }
}
