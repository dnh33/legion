/**
 * The last Claude Code listing that worked, saved as `<dataDir>/armory/sdk-listing.json`. When a later listing fails, the Armory uses
 * this one, so the skills the owner switched on keep applying. Written only after a successful listing; read only when a listing fails.
 * A file that is over 2 MB, unparsable or of the wrong shape is ignored, and bad entries in it are dropped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DiscoveredSkill, SkillSource } from './discover.js';
import { armoryDir } from './store.js';

export interface ListingCache {
  /** When the listing was taken (ISO time). */
  at: string;
  /** The Claude Code settings switch the listing ran with. A saved listing is used only while the switch is the same. */
  inherit: boolean;
  plugins: number;
  skills: DiscoveredSkill[];
  /** The commands of Claude Code itself (lower case), as Discovery.cli holds them. */
  cli: string[];
}

export const LISTING_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const SOURCES: readonly SkillSource[] = ['yours', 'imported', 'claude-personal', 'claude-plugin', 'claude-builtin'];
const FITS = ['fit', 'self', 'other'] as const;

export const listingCachePath = (dataDir: string): string => join(armoryDir(dataDir), 'sdk-listing.json');

/** Atomic: a crash mid-write leaves the old file. Throws when the write fails or the listing is too big to keep. */
export function writeListingCache(dataDir: string, cache: ListingCache): void {
  const text = JSON.stringify(cache);
  if (Buffer.byteLength(text, 'utf8') > LISTING_CACHE_MAX_BYTES) throw new Error('the listing is over 2 MB');
  const target = listingCachePath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* leave it */ }
    throw err;
  }
}

/** One saved skill, or undefined when the four required fields are not strings or the source is not one Legion knows. */
function skillOf(v: unknown): DiscoveredSkill | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.description !== 'string' || typeof r.source !== 'string') return undefined;
  if (!SOURCES.includes(r.source as SkillSource)) return undefined;
  const fit = FITS.find((f) => f === r.fit);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    source: r.source as SkillSource,
    ...(typeof r.plugin === 'string' ? { plugin: r.plugin } : {}),
    path: typeof r.path === 'string' ? r.path : null,
    manualOnlyInFrontmatter: r.manualOnlyInFrontmatter === true,
    ...(fit ? { fit } : {}),
    ...(typeof r.offReason === 'string' ? { offReason: r.offReason } : {}),
    ...(r.origin === 'claude-ai' ? { origin: 'claude-ai' as const } : {}),
    ...(typeof r.unsafeReason === 'string' ? { unsafeReason: r.unsafeReason } : {}),
  };
}

/** The saved listing, or undefined when there is none, it is over 2 MB, it cannot be read, or its header is not what we wrote. */
export function readListingCache(dataDir: string): ListingCache | undefined {
  const path = listingCachePath(dataDir);
  try {
    if (statSync(path).size > LISTING_CACHE_MAX_BYTES) return undefined;
    const o = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const r = o as Record<string, unknown>;
    if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at)) || typeof r.inherit !== 'boolean') return undefined;
    const skills = Array.isArray(r.skills) ? r.skills.map(skillOf).filter((s): s is DiscoveredSkill => !!s) : [];
    const cli = Array.isArray(r.cli) ? r.cli.filter((c): c is string => typeof c === 'string') : [];
    const plugins = typeof r.plugins === 'number' && Number.isFinite(r.plugins) && r.plugins >= 0 ? Math.floor(r.plugins) : 0;
    return { at: r.at, inherit: r.inherit, plugins, skills, cli };
  } catch {
    return undefined;
  }
}
