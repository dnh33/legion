/** The packs the Settings picker lists: every uisfx pack, plus any Legion pack registered below. */
import { PACKS } from './vendor/uisfx/index.js';
import type { SoundRecipe } from './vendor/uisfx/index.js';
import type { Cue } from './soundLogic.js';

export interface SoundPackInfo { id: string; label: string; description: string; custom: boolean }

/**
 * A custom pack is data: one recipe per cue (the recipe shape the vendored runtime renders to an AudioBuffer). The service renders
 * each recipe once and plays it through the same volume and gate as the built-in packs. A cue a pack leaves out is silent for that pack.
 * An id must not match a built-in pack id.
 */
export interface CustomPack { id: string; label: string; description: string; recipes: Partial<Record<Cue, SoundRecipe>> }

/**
 * Registry for the two original Legion packs (Forge and Reliquary). They come from a separate sound-design round and are
 * not shipped yet (the final recipe module is handed over when approved): this stays empty, so the picker shows no pack that does not exist. To add one, put a CustomPack here.
 */
export const CUSTOM_PACKS: readonly CustomPack[] = [];

/** New users get Forge. Until the Forge module is registered above, the built-in Minimal pack stands in, so a fresh install is never silent or broken. */
export const DEFAULT_PACK = 'forge';
export const FALLBACK_PACK = 'minimal';

export function listPacks(custom: readonly CustomPack[] = CUSTOM_PACKS): SoundPackInfo[] {
  const built = PACKS.map((p) => ({ id: p.name as string, label: p.label as string, description: p.description as string, custom: false }));
  const ids = new Set(built.map((p) => p.id));
  return [...built, ...custom.filter((c) => !ids.has(c.id)).map((c) => ({ id: c.id, label: c.label, description: c.description, custom: true }))];
}

/** The pack a new user hears: Forge when it exists, else Minimal. */
export function defaultPack(packs: readonly SoundPackInfo[] = listPacks()): string {
  return packs.some((p) => p.id === DEFAULT_PACK) ? DEFAULT_PACK : FALLBACK_PACK;
}

/** A stored pack id that does not exist (a pack removed in an update, or Forge before it ships) becomes the default pack. */
export function packOrDefault(id: string, packs: readonly SoundPackInfo[] = listPacks()): string {
  return packs.some((p) => p.id === id) ? id : defaultPack(packs);
}

/** The preview: three cues one after the other (ms from the start). */
export const PREVIEW_SEQUENCE: ReadonlyArray<{ cue: Cue; at: number }> = [{ cue: 'notification', at: 0 }, { cue: 'success', at: 900 }, { cue: 'complete', at: 1500 }];
