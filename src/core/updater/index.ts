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
import { outcomePath, readOutcome, removeOwned, type Outcome } from './apply.js';
import { DRAIN_MS, FREEZE_MAX_MS, LIMITS, manifestUrl, POLL_MS, PRODUCTION_SOURCE, RETRY_MS, SAMPLE_MS, sigUrl, type UpdateSource } from './config.js';
import { computeBusy, QuietClock, type BusyProbe } from './idle.js';
import { checkPolicy, ManifestError, parseManifest, type Manifest, type PolicyVerdict } from './manifest.js';
import { fetchSmall, NetError, type FetchLike } from './net.js';
import { stagePackage, stagedTree, StageError, dependencyHash, type Staged } from './package.js';
import { UpdaterFiles, type UpdateSettings } from './state.js';
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
  // The rest exist for tests. legion-core.ts passes none of them (test/updater-surface.test.ts checks that).
  source?: UpdateSource; keys?: readonly UpdateKey[]; fetchImpl?: FetchLike; version?: string; platform?: NodeJS.Platform;
  now?: () => number; timers?: boolean; freeBytes?: (dir: string) => number;
}
type Phase = 'idle' | 'checking' | 'awaiting-approval' | 'downloading' | 'staged' | 'committing';
export interface UpdateStatus {
  mode: InstallMode; keyConfigured: boolean; installed: { version: string; publishedAt?: string }; settings: UpdateSettings;
  check: { lastCheckedAt?: string; lastResult?: string; nextAllowedAt?: string };
  available?: { version: string; size: number; notes: string; publishedAt: string; requiresFullInstall: boolean };
  phase: Phase; progress?: { bytes: number; total: number }; error?: string;
  staged?: { version: string }; consent: boolean; readyToApply: boolean;
  busy: { idle: boolean; reasons: string[]; quietMs: number };
  outcome?: Outcome; stopped?: { tasks: Array<{ id: string; agentId: string }>; at?: string };
}
export interface UpdaterModule extends CoreModule {
  registerBusyProbe(name: string, probe: BusyProbe): void;
  check(manual?: boolean): Promise<void>;
  status(): Promise<UpdateStatus>;
  install(o?: { auto?: boolean }): Promise<{ ok: boolean; declined?: boolean }>;
  drain(): Promise<{ stopped: Array<{ id: string; agentId: string }>; settled: boolean }>;
  commit(o?: { force?: boolean }): Promise<{ installDir: string; stagedDir: string; from: string; to: string }>;
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
  if (prior && (prior.result === 'rolled-back') && !files.state().failedVersions.includes(prior.to)) files.saveState({ failedVersions: [...files.state().failedVersions, prior.to] });
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
      const [mBytes, sigBytes] = [
        await fetchSmall(manifestUrl(source), source.policy, { maxBytes: LIMITS.manifestBytes, version, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
        await fetchSmall(sigUrl(source), source.policy, { maxBytes: LIMITS.sigBytes, version, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
      ];
      const v = verifyManifestSignature(mBytes, sigBytes.toString('utf8'), keys);
      if (!v.ok) { available = null; settle(`rejected: ${v.reason}`); return; }
      const m = parseManifest(mBytes); // parsed only after the signature verified
      const verdict: PolicyVerdict = checkPolicy(m, { running: { version, ...buildInfo() }, nowMs: now(), failedVersions: files.state().failedVersions });
      if (!verdict.ok) { if (verdict.code !== 'up-to-date') settle(`rejected: ${verdict.reason}`); else settle('up to date'); available = null; return; }
      if (staged && staged.version !== m.version) { clearStage(); }
      available = { manifest: m };
      settle(`update available: ${m.version}`);
      error = undefined;
    } catch (e) {
      available = null;
      if (e instanceof NetError) {
        if (e.kind === 'rate-limit') nextAllowedAt = now() + (e.retryAfterMs ?? 3600_000);
        settle(e.kind === 'offline' || e.kind === 'timeout' ? 'offline: could not reach the update server' : e.kind === 'rate-limit' ? 'the update server asked us to wait' : e.kind === 'http' && /404/.test(e.message) ? 'no release found' : `could not check: ${e.message}`);
      } else if (e instanceof ManifestError) settle(`rejected: ${e.message}`);
      else { settle('could not check for updates'); log('updater check failed', e instanceof Error ? e.message : String(e)); }
    } finally {
      phase = was === 'staged' ? 'staged' : 'idle';
    }
    if (available && !staged && mode === 'apply' && !available.manifest.requiresFullInstall && files.settings().autoInstallWhenIdle) void module.install({ auto: true }).catch(() => undefined);
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
      const a = available?.manifest;
      return {
        mode, keyConfigured: keys.length > 0, installed: { version, ...buildInfo() }, settings,
        check: { ...(s.lastCheckedAt ? { lastCheckedAt: s.lastCheckedAt } : {}), ...(s.lastResult ? { lastResult: s.lastResult } : {}), ...(nextAllowedAt > now() ? { nextAllowedAt: new Date(nextAllowedAt).toISOString() } : {}) },
        ...(a ? { available: { version: a.version, size: a.asset.size, notes: a.notes, publishedAt: a.publishedAt, requiresFullInstall: a.requiresFullInstall } } : {}),
        phase, ...(progress && phase === 'downloading' ? { progress } : {}), ...(error ? { error } : {}),
        ...(staged ? { staged: { version: staged.version } } : {}), consent,
        readyToApply: mode === 'apply' && !!staged && consent && reasons.length === 0 && clock.isQuiet(now()),
        busy: { idle: reasons.length === 0 && clock.isQuiet(now()), reasons, quietMs: clock.quietMs(now()) },
        ...(outcome ? { outcome } : {}),
        ...(s.stoppedForUpdate.length ? { stopped: { tasks: s.stoppedForUpdate, ...(s.stoppedAt ? { at: s.stoppedAt } : {}) } } : {}),
      };
    },

    async install(o = {}): Promise<{ ok: boolean; declined?: boolean }> {
      if (mode !== 'apply') throw new HttpError(409, mode === 'checkout' ? 'This is a git checkout: update it with git pull and a rebuild.' : 'This install cannot be updated from inside Legion.');
      const a = available?.manifest;
      if (!a) throw new HttpError(409, 'There is no verified update to install. Check for updates first.');
      if (a.requiresFullInstall) throw new HttpError(409, 'This release changes dependencies. Download its source and run setup.cmd.');
      if (phase !== 'idle' && phase !== 'staged') throw new HttpError(409, 'An update is already being prepared.');
      if (staged?.version === a.version) { consent = true; return { ok: true }; }
      error = undefined;
      // CONSENT. There is no approval card on either path, and that is deliberate (owner directive 2026-10-03).
      //   - o.auto === true  -> the owner turned on "Install updates automatically when idle". That toggle carries its own
      //     confirmation (window.confirm on the setting, UpdatePanel.tsx:83) and its label PROMISES "without asking again",
      //     so raising a card here would contradict the UI. It is the working escape hatch for installs that predate this fix.
      //   - anything else    -> the owner clicked Update (the button fires POST /api/update/install, index.ts:285). The click
      //     IS the consent. Asking a second time was the double-consent bug: it stranded the panel on "Waiting for your answer
      //     in the approvals list", pointing at a list (the agent thread, ApprovalCard) not reachable from the update panel.
      // The card is not deleted from the codebase because `phase` still models an approval wait for the drain path; it is simply
      // no longer reachable from install(). What still stands between a GitHub download and running code: the release SIGNATURE
      // (verified before staging), requiresFullInstall (refuses dependency changes outright), and `consent` gating the commit
      // (readyToApply, index.ts:184) so a staged update waits for the owner AND for Legion to be idle.
      phase = 'downloading'; progress = { bytes: 0, total: a.asset.size };
      try {
        staged = await stagePackage({
          installDir: opts.root, source, manifest: a, version: a.version, installedDepsHash: installedDepsHash(),
          onProgress: (bytes, total) => { progress = { bytes, total }; },
          ...(opts.freeBytes ? { freeBytes: opts.freeBytes } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        consent = true; phase = 'staged';
        return { ok: true };
      } catch (e) {
        phase = 'idle'; staged = null; consent = false;
        if (e instanceof StageError) {
          error = e.code === 'full-install' ? 'This release changes dependencies. Download its source and run setup.cmd.' : `The update was not installed: ${e.message}`;
          if (e.code === 'full-install' && available) available.manifest = { ...available.manifest, requiresFullInstall: true };
        } else if (e instanceof NetError) error = `The update was not downloaded: ${e.message}`;
        else { error = 'The update could not be prepared.'; log('updater stage failed', e instanceof Error ? e.message : String(e)); }
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
      if (!staged || !consent) throw new HttpError(409, 'No update is staged and approved.');
      const dir = stagedTree(opts.root, staged.version);
      if (!dir) throw new HttpError(409, 'The staged update is incomplete; download it again.');
      const forced = !!o.force && now() - drainedAt < 60_000;
      const reasons = await busyNow();
      if (reasons.length) throw new HttpError(409, `Legion is busy: ${reasons.join('; ')}`);
      if (!forced && !clock.isQuiet(now())) throw new HttpError(409, 'Legion has not been quiet long enough yet.');
      freeze();
      phase = 'committing';
      files.backupState(deps.dataDir, version);
      await deps.store.flush();
      return { installDir: opts.root, stagedDir: dir, from: version, to: staged.version };
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
        if ('intervalHours' in body) { if (typeof body.intervalHours !== 'number' || !Number.isFinite(body.intervalHours)) throw new HttpError(400, 'intervalHours must be a number.'); patch.intervalHours = body.intervalHours; }
        return files.saveSettings(patch);
      });
      add('POST', '/api/update/install', async () => { const r = await module.install(); return { ...r, status: await module.status() }; });
      add('POST', '/api/update/cancel', async () => { if (phase === 'downloading' || phase === 'committing') throw new HttpError(409, 'Busy; try again in a moment.'); clearStage(); return module.status(); });
      add('POST', '/api/update/ack', async () => { try { rmSync(outcomePath(opts.root), { force: true }); } catch { /* ignore */ } files.saveState({ stoppedForUpdate: [] }); return module.status(); });
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
