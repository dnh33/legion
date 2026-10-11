/**
 * The cross-process update-in-progress marker: no two updates run at once, and no update runs while another one owns the install.
 *
 * A JSON marker at <install>/.update/update-in-progress.json (the update folder that already holds the apply journal) is created with
 * exclusive semantics — fail if it exists — BEFORE an update starts. When read back it is judged against the process that wrote it: it
 * is live only while its pid is alive AND that process's start time still matches the recorded startTimeMs. A recycled pid (Windows
 * hands pids out again quickly) fails the second check, so a marker left behind by a dead updater is reclaimed instead of blocking
 * every future update.
 *
 * Pure core with injected I/O (MarkerDeps) so every verdict is decided without touching a disk; the real deps live with the caller.
 */
export interface UpdateMarker {
  /** The process running the update. */
  pid: number;
  /** The start time of that process at the moment it took the marker — the pid-reuse guard. */
  startTimeMs: number;
  fromVersion: string;
  toVersion: string;
  /** When the update began (epoch ms). */
  startedAt: number;
}

export interface MarkerDeps {
  /** <install>/.update/update-in-progress.json */
  markerPath: string;
  now(): number;
  isPidAlive(pid: number): boolean;
  /** The process's start time (epoch ms), or null when the platform will not say. */
  getPidStartTime(pid: number): number | null;
  /** Creates the file only if it does not exist yet (O_EXCL); throws when it does. */
  createExclusive(path: string, content: string): void;
  /** The file's text, or null when it does not exist / cannot be read. */
  read(path: string): string | null;
  remove(path: string): void;
  log(msg: string): void;
}

export type BeginResult = { ok: true } | { ok: false; reason: 'in-progress' | 'error'; message: string };
export interface UpdateProgress {
  inProgress: boolean;
  /** The marker found on disk, when one was readable. */
  marker?: UpdateMarker;
  /** A marker exists (or existed) but belongs to no live update: safe to reclaim. */
  stale?: boolean;
}

export type MarkerProcState = { pidAlive: boolean; pidStartTimeMs: number | null };
export type MarkerVerdict =
  | { status: 'none' }
  | { status: 'active'; marker: UpdateMarker }
  | { status: 'stale'; marker: UpdateMarker; reason: 'dead-pid' | 'pid-reuse' };

export const MARKER_FILE_NAME = 'update-in-progress.json';

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Pure: the marker text becomes a marker only when every field is present and well-typed. Anything else is not a marker. */
export function parseMarker(raw: string | null): UpdateMarker | null {
  if (raw === null) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (!isPid(m.pid) || !isMs(m.startTimeMs) || !isMs(m.startedAt)) return null;
  if (typeof m.fromVersion !== 'string' || typeof m.toVersion !== 'string') return null;
  return { pid: m.pid, startTimeMs: m.startTimeMs, fromVersion: m.fromVersion, toVersion: m.toVersion, startedAt: m.startedAt };
}

/**
 * Pure: is this marker live? Live only while its process is alive AND still the same process (start time unchanged). A pid that is
 * alive but whose start time cannot be read stays ACTIVE on purpose: a wrong refusal is recoverable, a wrong reclaim runs two updates
 * over one install.
 */
export function judgeMarker(marker: UpdateMarker | null, proc: MarkerProcState): MarkerVerdict {
  if (!marker) return { status: 'none' };
  if (!proc.pidAlive) return { status: 'stale', marker, reason: 'dead-pid' };
  if (proc.pidStartTimeMs !== null && proc.pidStartTimeMs !== marker.startTimeMs) return { status: 'stale', marker, reason: 'pid-reuse' };
  return { status: 'active', marker };
}

function readAndJudge(deps: MarkerDeps): MarkerVerdict {
  const marker = parseMarker(deps.read(deps.markerPath));
  if (!marker) return { status: 'none' };
  const pidAlive = deps.isPidAlive(marker.pid);
  return judgeMarker(marker, { pidAlive, pidStartTimeMs: pidAlive ? deps.getPidStartTime(marker.pid) : null });
}

/**
 * Takes the marker for a new update. The exclusive create is the lock; a marker that blocks it is judged and, when stale, reclaimed
 * and created again — still exclusively, so a competing updater either wins that create or is refused.
 */
export function tryBeginUpdate(deps: MarkerDeps, info: { fromVersion: string; toVersion: string }): BeginResult {
  const nowMs = deps.now();
  const marker: UpdateMarker = {
    pid: process.pid,
    // this process's start time; now() only when the platform will not say (the judge then also reads null and stays cautious)
    startTimeMs: deps.getPidStartTime(process.pid) ?? nowMs,
    fromVersion: info.fromVersion,
    toVersion: info.toVersion,
    startedAt: nowMs,
  };
  const content = JSON.stringify(marker);
  const refuse = (live: UpdateMarker): BeginResult => {
    deps.log(`update already in progress (pid ${live.pid}: ${live.fromVersion} -> ${live.toVersion})`);
    return { ok: false, reason: 'in-progress', message: `an update is already in progress (pid ${live.pid}, ${live.fromVersion} -> ${live.toVersion})` };
  };
  try {
    deps.createExclusive(deps.markerPath, content);
    return { ok: true };
  } catch {
    const v = readAndJudge(deps);
    if (v.status === 'active') return refuse(v.marker);
    deps.log(`reclaiming the update marker (${v.status === 'stale' ? `stale: ${v.reason}` : 'unreadable'})`);
    try {
      deps.remove(deps.markerPath);
      deps.createExclusive(deps.markerPath, content);
    } catch (e) {
      const v2 = readAndJudge(deps);
      if (v2.status === 'active') return refuse(v2.marker);
      return { ok: false, reason: 'error', message: `could not create the update marker: ${errText(e)}` };
    }
    // the one race the exclusive create cannot close: another process reclaiming the same stale marker between our remove and create
    if (deps.read(deps.markerPath) !== content) return { ok: false, reason: 'error', message: 'the update marker was taken by another process while it was being reclaimed' };
    return { ok: true };
  }
}

/** The startup check: an update whose owner is still live means the caller must refuse to proceed. */
export function isUpdateInProgress(deps: MarkerDeps): UpdateProgress {
  const raw = deps.read(deps.markerPath);
  if (raw === null) return { inProgress: false };
  const marker = parseMarker(raw);
  if (!marker) return { inProgress: false, stale: true }; // a file that is not a marker: nothing running, safe to reclaim
  const pidAlive = deps.isPidAlive(marker.pid);
  const v = judgeMarker(marker, { pidAlive, pidStartTimeMs: pidAlive ? deps.getPidStartTime(marker.pid) : null });
  if (v.status === 'active') return { inProgress: true, marker };
  return { inProgress: false, marker, stale: true };
}

/** Drops the marker when the update is over (committed or rolled back). Best effort: cleanup must not be the failure. */
export function endUpdate(deps: MarkerDeps): void {
  try { deps.remove(deps.markerPath); } catch (e) { deps.log(`could not remove the update marker: ${errText(e)}`); }
}
