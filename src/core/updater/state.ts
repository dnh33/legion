/**
 * The updater's own small files in <dataDir>/updater/: settings.json (the three switches) and state.json (versions that failed their first
 * start, tasks stopped by the last restart, last check). Written atomically; unreadable or hand-edited values fall back to the defaults.
 * Nothing here is a trust anchor: what is applied is decided by the signed manifest, not by these files.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from './config.js';

export interface UpdateSettings { checkEnabled: boolean; autoInstallWhenIdle: boolean; intervalHours: number }
export interface StoppedTask { id: string; agentId: string }
export interface UpdaterState { failedVersions: string[]; lastCheckedAt?: string; lastResult?: string; stoppedForUpdate: StoppedTask[]; stoppedAt?: string }

export function normalizeSettings(raw: unknown): UpdateSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const h = typeof r.intervalHours === 'number' && Number.isFinite(r.intervalHours) ? Math.round(r.intervalHours) : DEFAULTS.intervalHours;
  return {
    checkEnabled: typeof r.checkEnabled === 'boolean' ? r.checkEnabled : DEFAULTS.checkEnabled,
    autoInstallWhenIdle: r.autoInstallWhenIdle === true, // anything but a real true is OFF
    intervalHours: Math.min(168, Math.max(1, h)),
  };
}
function readJson(file: string): unknown { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } }
function writeAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try { renameSync(tmp, file); } catch { try { rmSync(file, { force: true }); } catch { /* ignore */ } renameSync(tmp, file); }
}

export class UpdaterFiles {
  private readonly dir: string;
  constructor(dataDir: string) { this.dir = join(dataDir, 'updater'); }
  settings(): UpdateSettings { return normalizeSettings(readJson(join(this.dir, 'settings.json'))); }
  saveSettings(patch: Partial<UpdateSettings>): UpdateSettings {
    const next = normalizeSettings({ ...this.settings(), ...patch });
    writeAtomic(join(this.dir, 'settings.json'), next);
    return next;
  }
  state(): UpdaterState {
    const r = (readJson(join(this.dir, 'state.json')) ?? {}) as Partial<UpdaterState>;
    return {
      failedVersions: Array.isArray(r.failedVersions) ? r.failedVersions.filter((v): v is string => typeof v === 'string').slice(0, 50) : [],
      ...(typeof r.lastCheckedAt === 'string' ? { lastCheckedAt: r.lastCheckedAt } : {}),
      ...(typeof r.lastResult === 'string' ? { lastResult: r.lastResult.slice(0, 300) } : {}),
      stoppedForUpdate: Array.isArray(r.stoppedForUpdate) ? r.stoppedForUpdate.filter((t) => t && typeof t.id === 'string' && typeof t.agentId === 'string').slice(0, 50) : [],
      ...(typeof r.stoppedAt === 'string' ? { stoppedAt: r.stoppedAt } : {}),
    };
  }
  saveState(patch: Partial<UpdaterState>): UpdaterState { const next = { ...this.state(), ...patch }; writeAtomic(join(this.dir, 'state.json'), next); return next; }
  /** One copy of state.json from before a swap, so a human can recover if a newer build migrated it. Never restored automatically. */
  backupState(dataDir: string, fromVersion: string): void {
    try {
      const data = readFileSync(join(dataDir, 'state.json'));
      mkdirSync(this.dir, { recursive: true });
      for (const n of readdirSync(this.dir)) if (/^state-before-[0-9.]*\.json$/.test(n)) rmSync(join(this.dir, n), { force: true });
      writeFileSync(join(this.dir, `state-before-${fromVersion.replace(/[^0-9.]/g, '')}.json`), data);
    } catch { /* no state file yet, or unreadable: nothing to keep */ }
  }
}
