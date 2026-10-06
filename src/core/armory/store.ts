/**
 * The Armory's own state: `<dataDir>/armory/armory.json`, and the local plugin folder that holds the owner's skills.
 *
 *   <dataDir>/armory/armory.json
 *   <dataDir>/armory/plugin/legion-armory/skills/<name>/SKILL.md      (a local SDK plugin root; the plugin name is the folder name)
 *
 * Changed only through admin routes, never by a tool. Same limit as ADR 0011, stated plainly: a process running as the same OS
 * user can write these files. What a forged record can do is bounded the same way as a forged switch: a skill turned on this way
 * still loads as `imported` unless armory.json says `yours`, and an imported or plugin skill taints the run.
 *
 * Defaults are computed from the source, never written into the file, so a later change of default reaches skills nobody chose for.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ARMORY_PLUGIN } from '../../shared/skill-ids.js';
import type { SkillSource } from './discover.js';

export type SkillState = 'on' | 'manual' | 'off';
export type AgentGrant = 'all' | string[];
export const STATES: readonly SkillState[] = ['on', 'manual', 'off'];

/** `sha256` is the hash of the SKILL.md Legion wrote for the owner (source 'yours'). A 'yours' skill whose file no longer matches is read as imported. */
export interface SkillRecord { state: SkillState; source: SkillSource; plugin?: string; agents?: AgentGrant; sha256?: string }
export interface ArmoryFile {
  version: 1;
  /** One-time migrations already applied. */
  migrations: string[];
  skills: Record<string, SkillRecord>;
  ccNoticeSeen?: boolean;
  /** Owner switch (2026-10-06): let skills run inline shell commands when they load. Absent = false = blocked. */
  allowSkillShell?: boolean;
}

/** Run once, when armory.json does not exist yet: the one-time "choose which Claude Code skills your agents get" notice. */
export const MIGRATION_CC_NOTICE = 'cc-notice-v1';

export const sha256Of = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export const armoryDir = (dataDir: string): string => join(dataDir, 'armory');
export const armoryFilePath = (dataDir: string): string => join(armoryDir(dataDir), 'armory.json');
/** The folder handed to the SDK as `{ type: 'local', path }`. */
export const pluginRoot = (dataDir: string): string => join(armoryDir(dataDir), 'plugin', ARMORY_PLUGIN);
export const skillsDir = (dataDir: string): string => join(pluginRoot(dataDir), 'skills');
export const skillFolder = (dataDir: string, name: string): string => join(skillsDir(dataDir), name);

const fresh = (): ArmoryFile => ({ version: 1, migrations: [MIGRATION_CC_NOTICE], skills: {}, ccNoticeSeen: false });

/** Default state by source (owner decisions, 2026-10-06): the owner's own skills start on, everything else off. */
/** Every skill starts off, whoever wrote it: nothing reaches an agent until the owner turns it on. */
export const defaultState = (_source: SkillSource): SkillState => 'off';

function clean(raw: unknown): ArmoryFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  const skills: Record<string, SkillRecord> = {};
  const src = o.skills && typeof o.skills === 'object' && !Array.isArray(o.skills) ? o.skills as Record<string, unknown> : {};
  const SOURCES = ['yours', 'imported', 'claude-personal', 'claude-plugin', 'claude-builtin'];
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (!STATES.includes(r.state as SkillState) || !SOURCES.includes(r.source as string)) continue;
    const agents = r.agents === 'all' ? 'all' as const : Array.isArray(r.agents) ? (r.agents as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
    skills[id] = { state: r.state as SkillState, source: r.source as SkillSource, ...(typeof r.plugin === 'string' ? { plugin: r.plugin } : {}), ...(agents ? { agents } : {}), ...(typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) ? { sha256: r.sha256 } : {}) };
  }
  return {
    version: 1,
    migrations: Array.isArray(o.migrations) ? o.migrations.filter((m): m is string => typeof m === 'string') : [],
    skills,
    ...(typeof o.ccNoticeSeen === 'boolean' ? { ccNoticeSeen: o.ccNoticeSeen } : {}),
    ...(o.allowSkillShell === true ? { allowSkillShell: true } : {}),
  };
}

/** Atomic: a crash mid-write leaves the old file. */
export function writeArmoryFile(dataDir: string, file: ArmoryFile): void {
  const target = armoryFilePath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* leave it */ }
    throw err;
  }
}

/**
 * The state. Missing file: the first run of this version, so the one-time notice migration runs and is recorded. An unreadable file
 * is defaults in memory and is NOT overwritten (the owner may want to repair it), and it never re-runs a migration.
 */
export function readArmoryFile(dataDir: string): ArmoryFile {
  const path = armoryFilePath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const f = fresh();
      try { writeArmoryFile(dataDir, f); } catch { /* read-only: the notice shows again next start */ }
      return f;
    }
    return { version: 1, migrations: [MIGRATION_CC_NOTICE], skills: {}, ccNoticeSeen: true };
  }
  try {
    return clean(JSON.parse(text)) ?? { version: 1, migrations: [MIGRATION_CC_NOTICE], skills: {}, ccNoticeSeen: true };
  } catch {
    return { version: 1, migrations: [MIGRATION_CC_NOTICE], skills: {}, ccNoticeSeen: true };
  }
}

export function updateArmoryFile(dataDir: string, fn: (f: ArmoryFile) => void): ArmoryFile {
  const f = readArmoryFile(dataDir);
  fn(f);
  writeArmoryFile(dataDir, f);
  return f;
}

/** Writes one skill folder atomically enough: files go to a sibling temp folder, then the folder is swapped in. */
export function writeSkillFolder(dataDir: string, name: string, files: Record<string, string>): void {
  const dest = skillFolder(dataDir, name);
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(tmp, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text, 'utf8');
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
}

export function removeSkillFolder(dataDir: string, name: string): void {
  rmSync(skillFolder(dataDir, name), { recursive: true, force: true });
}
