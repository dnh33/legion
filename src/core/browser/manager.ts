/** Holds one BrowserSession per run: idle and wall timers, a cap on live processes, and the kill when a run ends or Legion shuts down. */
import { BROWSER_LIMITS } from '../../shared/browser.js';
import { BrowserSession } from './session.js';

export interface RunEntry {
  taskId: string;
  session: BrowserSession;
  /** The owner has approved the first page of this run. */
  firstUseApproved: boolean;
  /** Set by the tools on every call (they know the agent, the mode and the approval card); the session asks it when a click or submit lands on a new site. Absent = denied. */
  approveOrigin?: (origin: string, url: string) => Promise<boolean>;
  /** Tool calls of one run go one at a time. */
  queue: Promise<unknown>;
}

export class BrowserManager {
  private readonly entries = new Map<string, RunEntry & { idle?: ReturnType<typeof setTimeout>; wall?: ReturnType<typeof setTimeout> }>();
  private live = 0;
  private readonly lim: typeof BROWSER_LIMITS;

  constructor(private readonly make: (taskId: string, reserve: () => () => void) => BrowserSession, limits: Partial<typeof BROWSER_LIMITS> = {}) { this.lim = { ...BROWSER_LIMITS, ...limits }; }

  /** Takes a slot for one browser process; throws when the cap is reached. The returned function frees the slot (idempotent). */
  readonly reserve = (): (() => void) => {
    if (this.live >= this.lim.maxProcesses) throw new Error(`${this.lim.maxProcesses} browsers are already running for other tasks. Try again later.`);
    this.live++;
    let freed = false;
    return () => { if (!freed) { freed = true; this.live--; } };
  };

  running(): number { return this.live; }

  entry(taskId: string): RunEntry {
    let e = this.entries.get(taskId);
    if (!e) {
      const session = this.make(taskId, this.reserve);
      e = { taskId, session, firstUseApproved: false, queue: Promise.resolve() };
      const wall = setTimeout(() => { void this.end(taskId); }, this.lim.wallMs);
      wall.unref?.();
      e.wall = wall;
      this.entries.set(taskId, e);
    }
    this.touch(taskId);
    return e;
  }

  /** Called on every tool call: the idle clock starts again. */
  touch(taskId: string): void {
    const e = this.entries.get(taskId);
    if (!e) return;
    if (e.idle) clearTimeout(e.idle);
    e.idle = setTimeout(() => { void this.end(taskId); }, this.lim.idleMs);
    e.idle.unref?.();
  }

  async end(taskId: string): Promise<void> {
    const e = this.entries.get(taskId);
    if (!e) return;
    this.entries.delete(taskId);
    if (e.idle) clearTimeout(e.idle);
    if (e.wall) clearTimeout(e.wall);
    await e.session.close().catch(() => undefined);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.end(id)));
  }

  has(taskId: string): boolean { return this.entries.has(taskId); }
  peek(taskId: string): RunEntry | undefined { return this.entries.get(taskId); }
}
