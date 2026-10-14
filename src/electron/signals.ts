/**
 * Electron side of the desktop signals (spec 3.9, 4.6): follows the core's event stream with the admin secret main already holds, keeps
 * the few facts the plan needs (open asks, counts, the owner's choices, this week's spend), asks `plan` (attention.ts, pure) what to do, and
 * does it: taskbar overlay, notifications, tray text. If the stream drops, the count is polled from GET /api/attention every 3 s until it is
 * back. Nothing is written to disk, and nothing but ids, names and numbers is read out of an event (signals-logic.ts).
 */
import { BrowserWindow, nativeImage, Notification } from 'electron';
import type { NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AttentionView, LegionEvent, StateSnapshot } from '../shared/types.js';
import { initialPlanState, plan, sanitizeName } from './attention.js';
import type { AskSignal, FocusInfo, NameLookup, Notif, NotifyLevel, PlanInput, PlanState, Prefs } from './attention.js';
import { OVERLAY_SIZES, overlayFile } from './overlay-files.js';
import { eventSignals, SseReader } from './signals-logic.js';

export interface SignalsDeps {
  /** The core's port and the admin header, only while main holds a proven core of its own. */
  core(): { port: number; headers: Record<string, string> } | undefined;
  /** `<install>/assets/overlay` */
  overlayDir: string;
  showWindow(): void;
  getWin(): BrowserWindow | null;
  setTray(tooltip: string, hasAsks: boolean): void;
  /** The window should open this ask (a notification was clicked). */
  openAsk(ref: { projectId?: string; taskId?: string }): void;
}
export interface Signals {
  /** Call for every new window: the overlay is set again and focus changes are followed. */
  attach(win: BrowserWindow): void;
  /** The window says what it shows (IPC). */
  setView(v: { pageProjectId: string | null; threadTaskId: string | null }): void;
  stop(): void;
}

const POLL_MS = 3000;
const SPEND_MS = 20_000;

export function startSignals(d: SignalsDeps): Signals {
  let stopped = false;
  let state: PlanState = initialPlanState();
  const open = new Map<string, AskSignal>();
  const statuses = new Map<string, string>();
  const agents = new Map<string, string>();
  const projects = new Map<string, string>();
  const taskProject = new Map<string, string>();
  let total = 0;
  let spent = 0;
  let spentAt = 0;
  let prefs: Prefs = { enabled: true, returnSummary: true, levels: {} };
  let view = { pageProjectId: null as string | null, threadTaskId: null as string | null };
  let pending: { failed: PlanInput['failed']; finished: PlanInput['finished']; budget: PlanInput['budget'] } = { failed: [], finished: [], budget: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastOverlay: { key: string | null; description: string } | undefined;
  let abort: AbortController | undefined;
  const live = new Set<Notification>();
  const imageCache = new Map<string, NativeImage>();

  const names: NameLookup = {
    agent: (id) => agents.get(id),
    project: (id) => projects.get(id),
    projectOfTask: (t) => taskProject.get(t),
  };

  async function get<T>(route: string): Promise<T | undefined> {
    const c = d.core();
    if (!c) return undefined;
    try {
      const r = await fetch(`http://127.0.0.1:${c.port}${route}`, { headers: c.headers, signal: AbortSignal.timeout(4000) });
      return r.ok ? ((await r.json()) as T) : undefined;
    } catch { return undefined; }
  }

  const focus = (): FocusInfo => {
    const w = d.getWin();
    const focused = !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused();
    return { focused, pageProjectId: view.pageProjectId, threadTaskId: view.threadTaskId };
  };

  function overlayImage(key: string): NativeImage | undefined {
    const hit = imageCache.get(key);
    if (hit) return hit;
    // one image with a representation per display scale: Windows picks the crisp one (16 px at 100%, 20 at 125%, 24 at 150%)
    const first = OVERLAY_SIZES[0]!;
    const base = join(d.overlayDir, overlayFile(key, first.px));
    if (!existsSync(base)) return undefined;
    const img = nativeImage.createFromPath(base);
    for (const s of OVERLAY_SIZES.slice(1)) {
      const f = join(d.overlayDir, overlayFile(key, s.px));
      if (existsSync(f)) img.addRepresentation({ scaleFactor: s.scale, buffer: nativeImage.createFromPath(f).toPNG() });
    }
    imageCache.set(key, img);
    return img;
  }

  function applyOverlay(w: BrowserWindow | null, o: { key: string | null; description: string } | undefined): void {
    if (!o || process.platform !== 'win32' || !w || w.isDestroyed()) return;
    try {
      const img = o.key === null ? undefined : overlayImage(o.key);
      if (o.key === null) w.setOverlayIcon(null, '');
      else if (img) w.setOverlayIcon(img, o.description);
    } catch { /* a taskbar that refuses the icon must not stop Legion */ }
  }

  function show(n: Notif): void {
    if (!Notification.isSupported()) return;
    try {
      const note = new Notification({ title: n.title, body: n.body, silent: false });
      live.add(note);
      const done = (): void => { live.delete(note); };
      note.on('click', () => {
        done();
        d.showWindow();
        d.openAsk(n.target);
      });
      note.on('close', done);
      note.on('failed', done);
      note.show();
      setTimeout(done, 60_000).unref?.();
    } catch { /* toasts are best effort */ }
  }

  async function refreshSpend(force = false): Promise<void> {
    if (!force && Date.now() - spentAt < SPEND_MS) return;
    spentAt = Date.now();
    const s = await get<{ week?: number }>('/api/spend?scope=app');
    if (s && typeof s.week === 'number') spent = s.week;
  }

  async function refreshPrefs(): Promise<void> {
    const a = await get<{ app?: { quiet?: Prefs['quiet']; notify?: { enabled?: boolean; returnSummary?: boolean } }; projects?: Record<string, { notify?: NotifyLevel }> }>('/api/away');
    if (!a) return;
    const levels: Prefs['levels'] = {};
    for (const [id, p] of Object.entries(a.projects ?? {})) if (p?.notify) levels[id] = p.notify;
    prefs = { enabled: a.app?.notify?.enabled !== false, returnSummary: a.app?.notify?.returnSummary !== false, ...(a.app?.quiet ? { quiet: a.app.quiet } : {}), levels };
  }

  async function seed(): Promise<void> {
    const [st, pr, at] = await Promise.all([get<StateSnapshot>('/api/state?slim=1'), get<Array<{ id: string; name: string }>>('/api/projects'), get<AttentionView>('/api/attention')]);
    if (st) {
      agents.clear();
      for (const a of st.agents) agents.set(a.id, a.name);
      for (const t of st.tasks) { if (t.projectId) taskProject.set(t.id, t.projectId); statuses.set(t.id, t.status); }
      open.clear();
      const fixed = (kind: AskSignal['kind'], s: { id: string; taskId: string; agentId: string; projectId?: string }): void => {
        const projectId = s.projectId ?? taskProject.get(s.taskId) ?? null;
        open.set(`a:${s.id}`, { key: `a:${s.id}`, kind, agentName: sanitizeName(agents.get(s.agentId)), projectId, projectName: projectId ? sanitizeName(projects.get(projectId)) || null : null, taskId: s.taskId });
      };
      if (pr) { projects.clear(); for (const p of pr) projects.set(p.id, p.name); }
      for (const a of st.approvals) fixed('approval', a);
      for (const q of st.questions ?? []) fixed('question', q);
      for (const p of st.parked ?? []) fixed('parked', p);
    }
    if (at) total = at.total;
    await refreshPrefs();
    await refreshSpend(true);
  }

  function schedule(at: number | null): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (at === null || stopped) return;
    timer = setTimeout(() => void run(), Math.max(50, at - Date.now()));
    timer.unref?.();
  }

  async function run(): Promise<void> {
    if (stopped) return;
    const f = focus();
    if (!f.focused || prefs.quiet?.enabled) await refreshSpend();
    const asks = [...open.values()];
    const input: PlanInput = { total, asks, ...pending, spentUsd: spent, prefs, focus: f };
    pending = { failed: [], finished: [], budget: [] };
    const r = plan(state, input, Date.now());
    state = r.state;
    if (r.overlay) { lastOverlay = r.overlay; applyOverlay(d.getWin(), r.overlay); }
    d.setTray(r.tray.tooltip, r.tray.hasAsks);
    for (const n of r.notifications) show(n);
    schedule(r.wakeAt);
  }

  function onEvent(ev: LegionEvent): void {
    switch (ev.type) {
      case 'attention.updated': total = ev.attention.total; break;
      case 'away.updated': void refreshPrefs().then(() => run()); return;
      case 'agent.updated': agents.set(ev.agent.id, ev.agent.name); break;
      case 'project.updated': projects.set(ev.project.id, ev.project.name); break;
      case 'task.updated': if (ev.task.projectId) taskProject.set(ev.task.id, ev.task.projectId); break;
      default: break;
    }
    const sig = eventSignals(ev, open, names, statuses);
    if (sig.failed) pending.failed.push(...sig.failed);
    if (sig.finished) pending.finished.push(...sig.finished);
    if (sig.budget) pending.budget.push(...sig.budget);
    void run();
  }

  /** The stream, forever: reconnects after a drop, and polls the count meanwhile. */
  async function follow(): Promise<void> {
    while (!stopped) {
      const c = d.core();
      if (!c) { await sleep(POLL_MS); continue; }
      abort = new AbortController();
      try {
        const res = await fetch(`http://127.0.0.1:${c.port}/api/events`, { headers: c.headers, signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        await seed();
        await run();
        const reader = new SseReader();
        const dec = new TextDecoder();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (stopped) break;
          for (const ev of reader.push(dec.decode(chunk, { stream: true }))) onEvent(ev as LegionEvent);
        }
      } catch { /* dropped: fall through to the poll */ }
      if (stopped) return;
      // the stream is down: keep the number honest by polling until it can be opened again
      const until = Date.now() + POLL_MS;
      const at = await get<AttentionView>('/api/attention');
      if (at && at.total !== total) { total = at.total; await run(); }
      await sleep(Math.max(0, until - Date.now()));
    }
  }

  void follow();

  return {
    attach(w) {
      const rerun = (): void => void run();
      for (const e of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) w.on(e as 'focus', rerun);
      w.on('closed', rerun);
      // a new window has no overlay yet
      applyOverlay(w, lastOverlay);
    },
    setView(v) { view = v; void run(); },
    stop() { stopped = true; abort?.abort(); if (timer) clearTimeout(timer); },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
