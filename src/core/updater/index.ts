/**
 * The updater core module: checks GitHub for a signed release manifest, stages a verified package after the user's go-ahead, decides
 * when the core is idle, and hands main the facts it needs to swap and restart. It never restarts anything itself and never runs git or npm.
 * Plan: claude/plan-updater.md. All routes are admin-only by the default-deny gate (none is on the client list); commit/drain/abort also
 * need the native secret, which only the Electron main process holds.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../../shared/config.js';
import { safeEqual, NATIVE_HEADER } from '../admin.js';
import type { CoreModule, ModuleDeps, RouteAdder } from '../modules.js';
import { HttpError } from '../server.js';
import { FULL_PACKAGE_SET, outcomePath, readOutcome, removeOwned, type Outcome } from './apply.js';
import { newUpdateId, type JourneyStepId, type JourneyView } from './journey.js';
import { readLastJourney, recordStep, type StepExtra } from './journey-io.js';
import { DRAIN_MS, FREEZE_MAX_MS, LIMITS, manifest2Url, manifestUrl, POLL_MS, PRODUCTION_SOURCE, RETRY_MS, SAMPLE_MS, sig2Url, sigUrl, type UpdateSource } from './config.js';
import { planRelease } from './deps-change.js';
import { isUpdateInProgress, type MarkerDeps } from './update-marker.js';
import { BOOT_REASON, computeBusy, QuietClock, type BusyProbe } from './idle.js';
import { checkPolicy, ManifestError, manifestForUpdater, parseManifest, type Manifest, type PolicyVerdict } from './manifest.js';
import { fetchSmall, NetError, type FetchLike } from './net.js';
import { stagePackage, stageFullPackage, stagedInfo, StageError, dependencyHash, type Staged } from './package.js';
import { FAILED_BLOCK_DAYS, UpdaterFiles, pruneFailed, type UpdateSettings } from './state.js';
import { compareSemver } from './semver.js';
import { UPDATE_KEYS, verifyManifestSignature, type UpdateKey } from './trust.js';

export type InstallMode = 'apply' | 'checkout' | 'unwritable' | 'unsupported';
/** Where an update may be applied. A git checkout, an unwritable folder or a non-Windows system only ever gets a notice. */
export function installMode(i: { root: string; platform: NodeJS.Platform; exists?: (p: string) => boolean; writable?: (p: string) => boolean }): InstallMode {
  const exists = i.exists ?? existsSync;
  if (exists(join(i.root, '.git'))) return 'checkout';
  if (i.platform !== 'win32') return 'unsupported';
  const writable = i.writable ?? ((p: string) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } });
  return writable(i.root) ? 'apply' : 'unwritable';
}

export interface UpdaterOptions {
  root: string;
  nativeSecret?: string | undefined;
  log?: (...a: unknown[]) => void;
  probes?: Record<string, BusyProbe>;
  /**
   * The gate reader. `update-consent` is a global gate: off means a found update downloads and installs by itself once Legion is idle, with no click.
   * Absent (tests, an install without gates): consent stays the owner's click.
   * A goal that is running is a busy reason like any other: the goal module registers a probe named 'a goal is running' (absent today, so absent = not running).
   */
  gates?: { gate(id: string): unknown };
  // The rest exist for tests. legion-core.ts passes none of them (test/updater-surface.test.ts checks that).
  source?: UpdateSource; keys?: readonly UpdateKey[]; fetchImpl?: FetchLike; version?: string; platform?: NodeJS.Platform;
  now?: () => number; timers?: boolean; freeBytes?: (dir: string) => number;
  /** Cross-process update marker (update-marker.ts). When present, install() refuses if another process owns an update. */
  marker?: MarkerDeps;
}
type Phase = 'idle' | 'checking' | 'awaiting-approval' | 'downloading' | 'staged' | 'committing';
export interface UpdateStatus {
  mode: InstallMode; keyConfigured: boolean; installed: { version: string; publishedAt?: string }; settings: UpdateSettings;
  check: { lastCheckedAt?: string; lastResult?: string; nextAllowedAt?: string };
  available?: { version: string; size: number; notes: string; publishedAt: string; requiresFullInstall: boolean; /** True when a dependency-change release ships a signed full package and can self-apply. */ canFullInstall: boolean };
  phase: Phase; progress?: { bytes: number; total: number }; error?: string;
  staged?: { version: string; kind: 'code' | 'full' }; consent: boolean; readyToApply: boolean;
  busy: { idle: boolean; reasons: string[]; quietMs: number };
  outcome?: Outcome; stopped?: { tasks: Array<{ id: string; agentId: string }>; at?: string };
  /** Versions held back after a rolled-back first start, and when each may be retried. Empty when none. */
  blocked?: Array<{ version: string; at?: string; retryAfter?: string }>;
  /** The newest update journey: every step with its state and time, and the result. Settings, About shows it. */
  journey?: JourneyView;
  /** Set once, right after an update landed: the new build is running and the owner has not dismissed the notice. */
  updated?: { version: string; id: string };
}
export interface UpdaterModule extends CoreModule {
  registerBusyProbe(name: string, probe: BusyProbe): void;
  check(manual?: boolean): Promise<void>;
  status(): Promise<UpdateStatus>;
  install(o?: { byGate?: boolean }): Promise<{ ok: boolean; declined?: boolean }>;
  drain(): Promise<{ stopped: Array<{ id: string; agentId: string }>; settled: boolean }>;
  commit(o?: { force?: boolean }): Promise<{ installDir: string; stagedDir: string; from: string; to: string; names?: readonly string[]; updateId?: string }>;
  abortCommit(): void;
}

const sha256File = (p: string): string | undefined => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return undefined; } };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createUpdaterModule(deps: ModuleDeps, opts: UpdaterOptions): UpdaterModule {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => Date.now());
  const version = opts.version ?? VERSION;
  const source = opts.source ?? PRODUCTION_SOURCE;
  const keys = opts.keys ?? UPDATE_KEYS;
  const files = new UpdaterFiles(deps.dataDir);
  const mode = installMode({ root: opts.root, platform: opts.platform ?? process.platform });
  const startedAt = now();
  const clock = new QuietClock(startedAt);
  const probes = new Map<string, BusyProbe>(Object.entries(opts.probes ?? {}));
  const timers: NodeJS.Timeout[] = [];

  let phase: Phase = 'idle';
  let available: { manifest: Manifest } | null = null;
  let staged: Staged | null = null;
  let consent = false;
  // Versions whose staging failed (hash, signature, disk, network), when. The automatic triggers skip them for a day (or until restart);
  // the owner's own click is never held back.
  const stageFailedAt = new Map<string, number>();
  const STAGE_RETRY_MS = 24 * 3600_000;
  // `update-consent` off: nobody has to say yes. Read at every use, so switching the gate takes the next status or check.
  // An update staged by the gate alone never sets `consent` (that is the owner's click, or their auto-install setting): switching the gate
  // back on therefore stops the apply until the owner says yes. A throwing reader means the gate is on.
  const consentOff = (): boolean => { try { return opts.gates?.gate('update-consent') === false; } catch { return false; } };
  let error: string | undefined;
  let progress: { bytes: number; total: number } | undefined;
  let nextAllowedAt = 0;
  let lastManualAt = 0;
  // When the last automatic check was ATTEMPTED (successful or not). `lastCheckedAt` only records success, so on a fresh install —
  // or after a network failure — there is no timestamp and the poll would otherwise retry every minute.
  let attemptedAt = 0;
  let drainedAt = 0;
  let frozen = false;
  let freezeTimer: NodeJS.Timeout | null = null;
  let checking: Promise<void> | null = null;
  // The update journey (journey.ts): one id from the moment an applicable update is found, carried through download, the app, the helper and the new build.
  let journeyId: string | undefined; let journeyTo: string | undefined; let journeyKind: 'code' | 'full' = 'code';
  const jr = (step: JourneyStepId, state: 'start' | 'done' | 'failed', extra: StepExtra = {}): void => {
    if (!journeyId || !journeyTo) return;
    try { recordStep({ installDir: opts.root, dataDir: deps.dataDir, id: journeyId, from: version, to: journeyTo, proc: 'core', kind: journeyKind, now }, step, state, extra); } catch { /* a log line never stops an update */ }
  };
  const beginJourney = (m: Manifest): void => {
    if (mode !== 'apply') return;
    const route = planRelease(m).route;
    if (route === 'notify') return; // nothing can be applied here, so there is no journey to follow
    if (journeyId && journeyTo === m.version) return; // the same update found again
    journeyId = newUpdateId(); journeyTo = m.version; journeyKind = route === 'full' ? 'full' : 'code';
    jr('checking', 'done', { note: `Legion ${m.version} is available` });
  };

  const buildInfo = (): { publishedAt?: string } => { try { const j = JSON.parse(readFileSync(join(opts.root, 'build-info.json'), 'utf8')) as { publishedAt?: unknown }; return typeof j.publishedAt === 'string' ? { publishedAt: j.publishedAt } : {}; } catch { return {}; } };
  const installedLock = (): string | undefined => sha256File(join(opts.root, 'package-lock.json'));
  // The DEPENDENCY hash of the installed lock, not the raw file hash: the lock carries its own version field, so the raw hash
  // changes on every release and would report "changes dependencies" for a patch that changes no dependency at all (see
  // dependencyHash in package.ts, owner directive 2026-10-03). Returns undefined when the install has no readable lock.
  const installedDepsHash = (): string | undefined => {
    try { return dependencyHash(readFileSync(join(opts.root, 'package-lock.json'), 'utf8')); } catch { return undefined; }
  };

  // The previous attempt's result (written by the apply helper): a rolled-back version is never offered again.
  const prior = readOutcome(opts.root);
  {
    const st = files.state();
    if (prior && prior.result === 'rolled-back' && !st.failedVersions.includes(prior.to)) {
      files.saveState({
        failedVersions: [...st.failedVersions, prior.to],
        failedAt: { ...(st.failedAt ?? {}), [prior.to]: new Date(now()).toISOString() },
      });
    }
    // A block that has outlived its window is dropped here, so a machine that rolled back once is not locked out of
    // that version forever. Expiry is the point: the loop this prevents is over once a fix has shipped.
    const pruned = pruneFailed(files.state().failedVersions, files.state().failedAt, now());
    if (pruned.expired.length) {
      const at = { ...(files.state().failedAt ?? {}) };
      for (const v of pruned.expired) delete at[v];
      files.saveState({ failedVersions: pruned.kept, failedAt: at });
    }
  }
  // A package that was staged and approved before a restart (and is still valid) is kept; the next check decides whether it is still wanted.
  const busyInputs = () => ({
    tasks: () => deps.store.listTasks(100000, undefined, true),
    running: () => deps.engine.running(),
    approvals: () => deps.approvals.pending(),
    vms: () => deps.store.listVms(),
    probes,
    updaterBusy: () => phase === 'checking' || phase === 'downloading' || phase === 'awaiting-approval' || phase === 'committing',
  });
  const busyNow = async (): Promise<string[]> => { const r = await computeBusy(busyInputs(), now(), startedAt); clock.sample(r, now()); return r; };

  const settle = (result: string): void => { files.saveState({ lastCheckedAt: new Date(now()).toISOString(), lastResult: result }); };

  async function doCheck(manual: boolean): Promise<void> {
    if (!keys.length) { settle('updates are off: this build has no update key'); return; }
    if (now() < nextAllowedAt) { if (manual) throw new HttpError(429, 'The update server asked us to wait; try again later.'); return; }
    if (phase === 'downloading' || phase === 'committing' || phase === 'awaiting-approval') return;
    const was = phase;
    phase = 'checking';
    try {
      const get = (url: string, maxBytes: number): Promise<Buffer> => fetchSmall(url, source.policy, { maxBytes, version, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
      // The second manifest name first; the old one only when the new one is not there at all (404). Any other failure of the new
      // name, and every failure of its signature or content below, stops the check: a bad new manifest must not fall back to an older one.
      let mBytes: Buffer; let sigUrlUsed: string;
      try { mBytes = await get(manifest2Url(source), LIMITS.manifestBytes); sigUrlUsed = sig2Url(source); }
      catch (e) {
        if (!(e instanceof NetError && e.status === 404)) throw e;
        mBytes = await get(manifestUrl(source), LIMITS.manifestBytes); sigUrlUsed = sigUrl(source);
      }
      const sigBytes = await get(sigUrlUsed, LIMITS.sigBytes);
      const v = verifyManifestSignature(mBytes, sigBytes.toString('utf8'), keys);
      if (!v.ok) { available = null; settle(`rejected: ${v.reason}`); return; }
      const full = parseManifest(mBytes); // parsed only after the signature verified
      const pick = manifestForUpdater(full);
      if (!pick.use) { available = null; settle(`rejected: ${pick.reason}`); return; }
      const m = pick.use;
      const verdict: PolicyVerdict = checkPolicy(m, { running: { version, ...buildInfo() }, nowMs: now(), failedVersions: files.state().failedVersions });
      if (!verdict.ok) {
        // A stone that is not newer than what runs leaves this client unable to reach the real release: say so, rather than "up to date".
        if (pick.use !== full) { settle(`rejected: ${full.version} needs a newer updater than this one, and no step update is available for it yet`); available = null; return; }
        if (verdict.code !== 'up-to-date') settle(`rejected: ${verdict.reason}`); else settle('up to date'); available = null; return;
      }
      if (staged && staged.version !== m.version) { clearStage(); }
      available = { manifest: m };
      beginJourney(m);
      settle(`update available: ${m.version}`);
      error = undefined;
    } catch (e) {
      available = null;
      if (e instanceof NetError) {
        if (e.kind === 'rate-limit') nextAllowedAt = now() + (e.retryAfterMs ?? 3600_000);
        settle(describeCheckFailure(e));
      } else if (e instanceof ManifestError) settle(`rejected: ${e.message}`);
      else { settle('could not check for updates'); log('updater check failed', e instanceof Error ? e.message : String(e)); }
    } finally {
      phase = was === 'staged' ? 'staged' : 'idle';
    }
    // Auto-install only when the release can actually be applied here: a code-only update, or a dependency-change
    // release that ships a signed full package (route 'full'). A notify-only release has nothing to download.
    if (available && !staged && mode === 'apply' && planRelease(available.manifest).route !== 'notify') {
      const failedAt = stageFailedAt.get(available.manifest.version);
      if (failedAt === undefined || now() - failedAt >= STAGE_RETRY_MS) {
        if (files.settings().autoInstallWhenIdle) void module.install().catch(() => undefined); // the setting is the owner's consent
        else if (consentOff()) void module.install({ byGate: true }).catch(() => undefined); // the gate stages it, and grants no consent
      }
    }
  }

  function clearStage(): void {
    staged = null; consent = false;
    try { removeOwned(opts.root, join(opts.root, '.update', 'staging')); } catch { /* ignore */ }
  }

  const freeze = (): void => {
    if (frozen) return;
    frozen = true;
    if (opts.timers !== false) { freezeTimer = setTimeout(() => module.abortCommit(), FREEZE_MAX_MS); freezeTimer.unref?.(); }
  };
  const engine = deps.engine as { startTask: (p: never) => unknown };
  const originalStart = engine.startTask.bind(deps.engine);
  engine.startTask = ((p: never) => {
    if (frozen) throw new HttpError(503, 'Legion is restarting to install an update. Try again in a moment.');
    return originalStart(p);
  }) as typeof engine.startTask;

  const needNative = (req: unknown): void => {
    const h = (req as { headers?: Record<string, string | string[] | undefined> }).headers?.[NATIVE_HEADER];
    const admin = !!(req as { legionAdmin?: boolean }).legionAdmin;
    if (!admin) throw new HttpError(403, 'admin_required');
    if (!opts.nativeSecret || typeof h !== 'string' || !safeEqual(h, opts.nativeSecret)) throw new HttpError(403, 'native_required: only the Legion app itself may do this');
  };

  const module: UpdaterModule = {
    id: 'updater',
    registerBusyProbe: (name, probe) => { probes.set(name, probe); },
    check: async (manual = false) => { if (checking) return checking; checking = doCheck(manual).finally(() => { checking = null; }); return checking; },

    async status(): Promise<UpdateStatus> {
      const reasons = await busyNow();
      const s = files.state();
      const settings = files.settings();
      const outcome = readOutcome(opts.root) ?? undefined;
      const journey = readLastJourney(opts.root) ?? undefined;
      const updated = journey && journey.result === 'ok' && journey.to === version && s.updatedAckId !== journey.id ? { version: journey.to, id: journey.id } : undefined;
      const a = available?.manifest;
      const st2 = files.state();
      const plan = a ? planRelease(a) : null;
      const at2 = st2.failedAt ?? {};
      // Only a block on a version NEWER than what is running can ever be acted on. An older one is history: the
      // updater only ever offers something newer, so a block on it is invisible to the user and unreleasable by them.
      // Owner, on the first run of this code: still on 0.2.3-f it showed "Version 0.2.3-g is being held back" for a
      // version it had already moved past, which reads as a pending problem rather than as nothing.
      const blocked = st2.failedVersions
        .filter((v) => compareSemver(v, version) > 0)
        .map((v) => ({ version: v, at: at2[v], retryAfter: at2[v] ? new Date(Date.parse(at2[v]) + FAILED_BLOCK_DAYS * 86_400_000).toISOString() : undefined }))
        .filter((b) => b.retryAfter ? Date.parse(b.retryAfter) <= now() : true);
      return {
        mode, keyConfigured: keys.length > 0, installed: { version, ...buildInfo() }, settings,
        check: { ...(s.lastCheckedAt ? { lastCheckedAt: s.lastCheckedAt } : {}), ...(s.lastResult ? { lastResult: s.lastResult } : {}), ...(nextAllowedAt > now() ? { nextAllowedAt: new Date(nextAllowedAt).toISOString() } : {}) },
        ...(a && plan ? { available: { version: a.version, size: plan.route === 'full' ? (a.fullAsset?.size ?? a.asset.size) : a.asset.size, notes: a.notes, publishedAt: a.publishedAt, requiresFullInstall: a.requiresFullInstall, canFullInstall: plan.route === 'full' } } : {}),
        phase, ...(progress && phase === 'downloading' ? { progress } : {}), ...(error ? { error } : {}),
        // What is blocked and until when. The owner met this as a bare "rejected: version X failed its first start"
        // with no way out, and had to guess that Check now was the unlock. Naming it here is the whole fix.
        ...(blocked.length ? { blocked } : {}),
        ...(staged ? { staged: { version: staged.version, kind: staged.kind } } : {}), consent: consent || consentOff(),
        readyToApply: mode === 'apply' && !!staged && (consent || consentOff()) && reasons.length === 0 && clock.isQuiet(now()),
        busy: { idle: reasons.length === 0 && clock.isQuiet(now()), reasons, quietMs: clock.quietMs(now()) },
        ...(outcome ? { outcome } : {}),
        ...(journey ? { journey } : {}),
        ...(updated ? { updated } : {}),
        ...(s.stoppedForUpdate.length ? { stopped: { tasks: s.stoppedForUpdate, ...(s.stoppedAt ? { at: s.stoppedAt } : {}) } } : {}),
      };
    },

    async install(o = {}): Promise<{ ok: boolean; declined?: boolean }> {
      if (mode !== 'apply') throw new HttpError(409, mode === 'checkout' ? 'This is a git checkout: update it with git pull and a rebuild.' : 'This install cannot be updated from inside Legion.');
      const a = available?.manifest;
      if (!a) throw new HttpError(409, 'There is no verified update to install. Check for updates first.');
      const plan = planRelease(a);
      // A dependency-change release with no signed full package can only be installed by hand: the human fallback, and
      // what every install that predates full-package support still gets.
      if (plan.route === 'notify') throw new HttpError(409, 'This release changes dependencies. Download its source and run setup.cmd.');
      if (phase !== 'idle' && phase !== 'staged') throw new HttpError(409, 'An update is already being prepared.');
      // Cross-process guard: refuse if another Legion process already owns an update (update-marker.ts).
      if (opts.marker) {
        const mp = isUpdateInProgress(opts.marker);
        if (mp.inProgress) throw new HttpError(409, 'Another Legion update is already in progress. Wait for it to finish.');
      }
      if (staged?.version === a.version) { if (!o.byGate) consent = true; return { ok: true }; }
      error = undefined;
      // CONSENT. There is no approval card on either path, and that is deliberate (owner directive 2026-10-03).
      //   - byGate           -> `update-consent` is off: this stages the package, and records no consent (see consentOff). Every check below runs the same.
      //   - the setting      -> the owner turned on "Install updates automatically when idle". That toggle carries its own
      //     confirmation (window.confirm on the setting, UpdatePanel.tsx:83) and its label PROMISES "without asking again",
      //     so raising a card here would contradict the UI. It is the working escape hatch for installs that predate this fix.
      //   - anything else    -> the owner clicked Update (the button fires POST /api/update/install, index.ts:285). The click
      //     IS the consent. Asking a second time was the double-consent bug: it stranded the panel on "Waiting for your answer
      //     in the approvals list", pointing at a list (the agent thread, ApprovalCard) not reachable from the update panel.
      // The card is not deleted from the codebase because `phase` still models an approval wait for the drain path; it is simply
      // no longer reachable from install(). What still stands between a GitHub download and running code: the release SIGNATURE
      // (verified before staging) for BOTH assets, the full package's own signed sha256 when the dependencies changed, and `consent`
      // gating the commit (readyToApply) so a staged update waits for the owner AND for Legion to be idle.
      const progressTotal = plan.route === 'full' ? (a.fullAsset?.size ?? a.asset.size) : a.asset.size;
      phase = 'downloading'; progress = { bytes: 0, total: progressTotal };
      // steps 2 and 3: the download ends when every byte has arrived; the signature and hash checks that follow are step 3
      let verifying = false; let last = { bytes: 0, total: progressTotal };
      if (!journeyId || journeyTo !== a.version) beginJourney(a);
      jr('downloading', 'start', { bytes: 0, total: progressTotal });
      const toVerifying = (): void => { if (verifying) return; verifying = true; jr('downloading', 'done', { bytes: last.bytes, total: last.total }); jr('verifying', 'start'); };
      const onProgress = (bytes: number, total: number): void => { progress = { bytes, total }; last = { bytes, total }; if (total > 0 && bytes >= total) toVerifying(); };
      const staged4 = (): void => { toVerifying(); jr('verifying', 'done'); jr('ready', 'done', { note: `Legion ${a.version} is ready to install` }); };
      const stageOpts = { installDir: opts.root, source, manifest: a, version: a.version, onProgress, ...(opts.freeBytes ? { freeBytes: opts.freeBytes } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
      try {
        // route 'full': the app package carries no node_modules, so stage the signed full package instead.
        staged = plan.route === 'full'
          ? await stageFullPackage(stageOpts)
          : await stagePackage({ ...stageOpts, installedDepsHash: installedDepsHash() });
        if (!o.byGate) consent = true; phase = 'staged';
        staged4();
        return { ok: true };
      } catch (e) {
        // The manifest did not declare the dependency change, but the app package's lock content differs from what is
        // installed (checkTree throws 'full-install'), or the install has no readable lock. When the release ALSO ships a
        // signed full package, apply that rather than giving up; otherwise this stays the notify-only fallback.
        let fellBack = false;
        if (e instanceof StageError && e.code === 'full-install' && a.fullAsset) {
          fellBack = true;
          log('updater stage refused, trying the signed full package', e.code, e.message); // the refusal that starts the fallback; a 285 MB failure must leave a trace
          journeyKind = 'full'; verifying = false; last = { bytes: 0, total: a.fullAsset?.size ?? progressTotal };
          jr('downloading', 'start', { bytes: 0, total: last.total, note: 'this release changes dependencies: downloading the full package' });
          try {
            staged = await stageFullPackage(stageOpts);
            if (!o.byGate) consent = true; phase = 'staged';
            staged4();
            return { ok: true };
          } catch (e2) { e = e2; }
        }
        phase = 'idle'; staged = null; consent = false;
        stageFailedAt.set(a.version, now());
        if (e instanceof StageError) {
          log('updater stage refused', e.code, e.message); // a refusal must be visible in the app log, not only in the panel
          error = e.code === 'full-install' ? 'This release changes dependencies. Download its source and run setup.cmd.' : `The update was not installed: ${e.message}`;
          if (e.code === 'full-install' && available) available.manifest = { ...available.manifest, requiresFullInstall: true };
        } else if (e instanceof NetError) {
          log(fellBack ? 'updater full package download failed' : 'updater download failed', e.message);
          error = `The update was not downloaded: ${e.message}`;
        }
        else { error = 'The update could not be prepared.'; log('updater stage failed', e instanceof Error ? e.message : String(e)); }
        jr('failed', 'done', { during: verifying ? 'verifying' : 'downloading', note: error ?? 'The update could not be prepared.' });
        return { ok: false };
      } finally { progress = undefined; }
    },

    async drain() {
      freeze();
      const live = deps.store.listTasks(100000, undefined, true).filter((t) => t.status === 'running' || t.status === 'queued').map((t) => ({ id: t.id, agentId: t.agentId }));
      for (const t of live) { try { deps.engine.cancel(t.id); } catch { /* ignore */ } }
      for (const id of deps.engine.running()) { try { deps.engine.cancel(id); } catch { /* ignore */ } }
      for (const p of deps.approvals.pending()) { try { deps.approvals.resolve(p.id, false); } catch { /* ignore */ } }
      const end = now() + DRAIN_MS;
      let settled = false;
      for (;;) {
        const still = deps.engine.running().length > 0 || deps.store.listTasks(100000, undefined, true).some((t) => t.status === 'running' || t.status === 'queued');
        if (!still) { settled = true; break; }
        if (now() >= end) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await deps.store.flush();
      drainedAt = now();
      files.saveState({ stoppedForUpdate: live, stoppedAt: new Date(now()).toISOString() });
      return { stopped: live, settled };
    },

    async commit(o = {}) {
      if (mode !== 'apply') throw new HttpError(409, 'This install cannot be updated from inside Legion.');
      if (!staged || !(consent || consentOff())) throw new HttpError(409, 'No update is staged and approved.');
      const info = stagedInfo(opts.root, staged.version);
      if (!info) throw new HttpError(409, 'The staged update is incomplete; download it again.');
      const forced = !!o.force && now() - drainedAt < 60_000;
      // the owner's Restart now (forced, right after a drain) is not held back by the start-up grace: that is a wait for the automatic install, not work
      const reasons = (await busyNow()).filter((r) => !(forced && r === BOOT_REASON));
      if (reasons.length) throw new HttpError(409, `Legion is busy: ${reasons.join('; ')}`);
      if (!forced && !clock.isQuiet(now())) throw new HttpError(409, 'Legion has not been quiet long enough yet.');
      freeze();
      phase = 'committing';
      files.backupState(deps.dataDir, version);
      await deps.store.flush();
      // A full-package stage returns FULL_PACKAGE_SET so the helper swaps node_modules and runtime too; a code-only
      // stage leaves it out and the helper swaps CODE_SET. commitMatches refuses any other set before it is written.
      if (!journeyId || journeyTo !== staged.version) { journeyId = newUpdateId(); journeyTo = staged.version; journeyKind = staged.kind; }
      return { installDir: opts.root, stagedDir: info.treeDir, from: version, to: staged.version, ...(staged.kind === 'full' ? { names: FULL_PACKAGE_SET } : {}), updateId: journeyId };
    },
    abortCommit() {
      frozen = false; if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
      if (phase === 'committing') phase = staged ? 'staged' : 'idle';
    },

    routes(add: RouteAdder) {
      add('GET', '/api/update/status', () => module.status());
      add('POST', '/api/update/check', async () => {
        if (now() - lastManualAt < 60_000) throw new HttpError(429, 'Checked a moment ago. Try again in a minute.');
        lastManualAt = now();
        await module.check(true);
        return module.status();
      });
      add('PATCH', '/api/update/settings', ({ body }) => {
        if (!isObj(body)) throw new HttpError(400, 'Expected an object.');
        const patch: Partial<UpdateSettings> = {};
        if ('checkEnabled' in body) { if (typeof body.checkEnabled !== 'boolean') throw new HttpError(400, 'checkEnabled must be true or false.'); patch.checkEnabled = body.checkEnabled; }
        if ('autoInstallWhenIdle' in body) { if (typeof body.autoInstallWhenIdle !== 'boolean') throw new HttpError(400, 'autoInstallWhenIdle must be true or false.'); patch.autoInstallWhenIdle = body.autoInstallWhenIdle; }
        if ('updateWindow' in body) { if (typeof body.updateWindow !== 'boolean') throw new HttpError(400, 'updateWindow must be true or false.'); patch.updateWindow = body.updateWindow; }
        if ('intervalHours' in body) { if (typeof body.intervalHours !== 'number' || !Number.isFinite(body.intervalHours)) throw new HttpError(400, 'intervalHours must be a number.'); patch.intervalHours = body.intervalHours; }
        return files.saveSettings(patch);
      });
      add('POST', '/api/update/install', async () => { const r = await module.install(); return { ...r, status: await module.status() }; });
      add('POST', '/api/update/cancel', async () => { if (phase === 'downloading' || phase === 'committing') throw new HttpError(409, 'Busy; try again in a moment.'); clearStage(); return module.status(); });
      // The way out of a block. Without this the only way to retry a rolled-back version was to wait out the window
      // or hand-edit state.json, and the panel said nothing about either. Admin-gated like every other route, so it
      // is the owner's click and not a run's.
      add('POST', '/api/update/retry', async (c) => {
        const v = (c.body as { version?: unknown } | undefined)?.version;
        if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'version is required');
        const st = files.state();
        if (!st.failedVersions.includes(v)) return module.status();
        const at = { ...(st.failedAt ?? {}) };
        delete at[v];
        files.saveState({ failedVersions: st.failedVersions.filter((x) => x !== v), failedAt: at });
        // And drop the outcome file, or the next start re-adds the version we just unblocked.
        try { rmSync(outcomePath(opts.root), { force: true }); } catch { /* ignore */ }
        return module.status();
      });
      add('POST', '/api/update/ack', async () => { try { rmSync(outcomePath(opts.root), { force: true }); } catch { /* ignore */ } files.saveState({ stoppedForUpdate: [] }); return module.status(); });
      add('POST', '/api/update/ack-updated', ({ body }) => { const id = isObj(body) && typeof body.id === 'string' ? body.id : ''; if (!/^[0-9a-f]{8}$/.test(id)) throw new HttpError(400, 'id is required'); files.saveState({ updatedAckId: id }); return { ok: true }; });
      add('POST', '/api/update/drain', ({ req }) => { needNative(req); return module.drain(); });
      add('POST', '/api/update/commit', ({ req, body }) => { needNative(req); return module.commit({ force: isObj(body) && body.force === true }); });
      add('POST', '/api/update/abort-commit', ({ req }) => { needNative(req); module.abortCommit(); return { ok: true }; });
    },

    dispose() { for (const t of timers) clearInterval(t); if (freezeTimer) clearTimeout(freezeTimer); },
  };

  if (opts.timers !== false) {
    const sample = setInterval(() => { void busyNow().catch(() => undefined); }, SAMPLE_MS); sample.unref?.(); timers.push(sample);
    // Check ON LAUNCH. This used to be a flat 30 s after boot with the 12 h interval as the only other trigger, which meant a
    // fresh install could sit for hours before it ever learned a release existed — and auto-install-when-idle depends on a check
    // happening first, so the escape hatch did not work either (owner found this 2026-10-03). Now: one check shortly after start
    // (delayed so it never competes with boot), then a 60 s poll that honours intervalHours. The launch check and the poll are
    // spaced by RETRY_MS so a quick app restart cannot hammer github.com.
    const first = setTimeout(() => { if (files.settings().checkEnabled) { attemptedAt = now(); void module.check(false); } }, 30_000);
    first.unref?.(); timers.push(first as unknown as NodeJS.Timeout);
    // The poll runs more often than intervalHours so an interval is honoured roughly on time rather than up to 10 min late.
    // `doCheck` has no recency guard of its own (it only backs off on a 429), so the spacing is enforced HERE: without this a
    // 60 s poll would fetch the manifest from github.com every minute. A launch check still gets its own request via `first`.
    const every = setInterval(() => {
      const s = files.settings();
      if (!s.checkEnabled) return;
      const last = Date.parse(files.state().lastCheckedAt ?? '');
      // No check has ever succeeded (no timestamp): retry on the next poll instead of waiting out the full interval, so a
      // transient network error cannot silence updates for hours. `attemptedAt` keeps that retry from becoming a busy loop.
      if (Number.isFinite(last) && now() - last >= s.intervalHours * 3600_000) { void module.check(false); return; }
      if (!Number.isFinite(last) && now() - attemptedAt >= RETRY_MS) { attemptedAt = now(); void module.check(false); }
    }, POLL_MS);
    every.unref?.(); timers.push(every);
  }
  return module;
}

/**
 * Why a check failed, in words a person can act on.
 *
 * Written out rather than nested inline because the previous one-liner was three ternaries deep and its last branch
 * put the raw exception text on screen: a DNS or TLS failure arrived as `could not check: getaddrinfo ENOTFOUND
 * api.github.com`, which names an internal host and offers the reader nothing. The kind is what we know; the
 * message is for the log. Unmapped kinds fall back to the plain sentence rather than leaking `e.message`.
 */
export function describeCheckFailure(e: { kind: string; message: string }): string {
  switch (e.kind) {
    case 'offline':
    case 'timeout':
      return 'offline: could not reach the update server';
    case 'rate-limit':
      return 'the update server asked us to wait';
    case 'http':
      return /404/.test(e.message) ? 'no release found' : 'the update server returned an error';
    default:
      return 'could not check for updates';
  }
}
