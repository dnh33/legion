/**
 * BlenderState: the Blender settings (config.json key "blender") and what Setup left on disk (<dataDir>/blender/setup.json).
 * Like BsvState it rewrites ONLY its own key of <dataDir>/config.json (never the in-memory config, which carries env-derived secrets),
 * and falls back to <dataDir>/blender.json when there is no config.json (tests, odd setups).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeConfigFile } from '../../shared/config.js';
import { defaultBlenderConfig, effectiveMode, mirrorSandbox, modeFromSandbox, normalizeBlender } from '../../shared/blender.js';
import type { AssetSource, BlenderBackendKind, BlenderMode, BlenderConfig, BlenderEntry, ServerSetupInfo } from '../../shared/blender.js';
import type { LegionConfig } from '../../shared/types.js';

export interface SetupRecord { official: ServerSetupInfo | null; community: ServerSetupInfo | null; addonInstalledFor: BlenderBackendKind | null }

/** What the settings route may change. Everything else (advanced, entry, host) is written by Setup or by hand in config.json. */
export interface BlenderPatch { both?: boolean; assets?: Partial<Record<AssetSource, boolean>>; enabled?: boolean; backend?: BlenderConfig['backend']; mode?: BlenderMode; sandbox?: BlenderConfig['sandbox']; port?: number; installPath?: string | null; baseDir?: string | null }

const isInfo = (v: unknown): v is ServerSetupInfo => !!v && typeof v === 'object' && typeof (v as ServerSetupInfo).url === 'string' && typeof (v as ServerSetupInfo).sha256 === 'string';

export class BlenderState {
  private cfg: BlenderConfig;
  private rec: SetupRecord = { official: null, community: null, addonInstalledFor: null };
  private readonly configFile: string;
  private readonly fallbackFile: string;
  private readonly setupFile: string;

  constructor(private readonly opts: { dataDir: string; config?: LegionConfig }) {
    this.configFile = join(opts.dataDir, 'config.json');
    this.fallbackFile = join(opts.dataDir, 'blender.json');
    this.setupFile = join(opts.dataDir, 'blender', 'setup.json');
    const fromConfig = (opts.config as { blender?: unknown } | undefined)?.blender;
    this.cfg = fromConfig !== undefined ? normalizeBlender(fromConfig) : this.readFallback();
    try {
      if (existsSync(this.setupFile)) {
        const o = JSON.parse(readFileSync(this.setupFile, 'utf8')) as Record<string, unknown>;
        this.rec = {
          official: isInfo(o.official) ? o.official : null,
          community: isInfo(o.community) ? o.community : null,
          addonInstalledFor: o.addonInstalledFor === 'official' || o.addonInstalledFor === 'community' ? o.addonInstalledFor : null,
        };
      }
    } catch { /* an unreadable record means "not set up yet" */ }
  }

  get config(): BlenderConfig { return this.cfg; }
  get setup(): SetupRecord { return this.rec; }

  /** Applies a validated change. Throws (keeping the old settings) when it cannot be saved. */
  update(patch: BlenderPatch): BlenderConfig {
    const next: BlenderConfig = { ...this.cfg };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.backend !== undefined) next.backend = patch.backend;
    if (patch.both !== undefined) { if (patch.both) next.both = true; else delete next.both; }
    if (patch.assets !== undefined) next.assets = { ...(this.cfg.assets ?? {}), ...patch.assets };
    // saving a mode is the only thing that writes the `mode` key; the legacy `sandbox` key is mirrored so a downgrade still opens
    let mode = patch.mode ?? (patch.sandbox !== undefined ? modeFromSandbox(patch.sandbox) : undefined);
    // Switching the bridge on is a choice made on this version: record the mode in force (derived from the legacy key) so the upgrade notice,
    // which means "enabled before this version and never chose a mode", is not shown to someone who just turned it on.
    if (mode === undefined && patch.enabled === true && !this.cfg.enabled && this.cfg.mode === undefined) mode = effectiveMode(this.cfg);
    if (mode !== undefined) { next.mode = mode; next.sandbox = mirrorSandbox(mode); }
    // an explicit choice (the first-use chooser or the Settings radio) is what ends the one-time question; switching the bridge on does not
    if (patch.mode !== undefined || patch.sandbox !== undefined) next.modeAsked = true;
    if (patch.port !== undefined) next.port = patch.port;
    if (patch.installPath !== undefined) { if (patch.installPath === null || !patch.installPath.trim()) delete next.installPath; else next.installPath = patch.installPath.trim(); }
    // The Blender folder. Cleared to undefined on blank so normalizeBlender restores the defaults rather than leaving an empty string as a base.
    if (patch.baseDir !== undefined) { if (patch.baseDir === null || !patch.baseDir.trim()) delete next.baseDir; else next.baseDir = patch.baseDir.trim(); }
    return this.commit(normalizeBlender(next));
  }

  /** Setup result: the MCP entry (official) and what was downloaded. */
  recordSetup(r: { kind: BlenderBackendKind; info?: ServerSetupInfo; entry?: BlenderEntry; addonInstalled: boolean; retrust?: boolean }): void {
    // the trusted hash is never overwritten by a different one from the same address unless the user re-trusted it
    const was = this.rec[r.kind];
    if (r.info && was && was.url === r.info.url && was.sha256 !== r.info.sha256 && r.retrust !== true) {
      throw new Error(`refusing to replace the trusted download hash (${was.sha256.slice(0, 12)}...) with ${r.info.sha256.slice(0, 12)}... without an explicit re-trust`);
    }
    if (r.entry) this.commit(normalizeBlender({ ...this.cfg, entry: r.entry }));
    const next: SetupRecord = { ...this.rec, ...(r.info ? { [r.kind]: r.info } : {}), ...(r.addonInstalled ? { addonInstalledFor: r.kind } : {}) };
    mkdirSync(dirname(this.setupFile), { recursive: true });
    writeFileSync(this.setupFile, JSON.stringify(next, null, 2), 'utf8');
    this.rec = next;
  }

  private commit(next: BlenderConfig): BlenderConfig {
    this.persist(next);
    this.cfg = next;
    const live = this.opts.config as { blender?: BlenderConfig } | undefined;
    if (live) live.blender = next;
    return next;
  }

  private readFallback(): BlenderConfig {
    try { return existsSync(this.fallbackFile) ? normalizeBlender(JSON.parse(readFileSync(this.fallbackFile, 'utf8'))) : defaultBlenderConfig(); } catch { return defaultBlenderConfig(); }
  }

  private persist(cfg: BlenderConfig): void {
    if (existsSync(this.configFile)) {
      const cur = JSON.parse(readFileSync(this.configFile, 'utf8')) as Record<string, unknown>;
      cur.blender = cfg;
      writeConfigFile(this.configFile, JSON.stringify(cur, null, 2));
    } else {
      writeFileSync(this.fallbackFile, JSON.stringify(cfg, null, 2), 'utf8');
    }
  }
}
