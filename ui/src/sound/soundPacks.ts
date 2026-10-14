/** The packs the Settings picker lists: every uisfx pack, plus any Legion pack registered below. */
import { PACKS } from './vendor/uisfx/index.js';
import type { RenderedSound } from './vendor/uisfx/index.js';
import './lore/lore.js';
import type { Cue } from './soundLogic.js';

export interface SoundPackInfo { id: string; label: string; description: string; custom: boolean }

/**
 * A custom pack is a recipe module: `render` turns one cue into stereo samples (the shape the vendored runtime's own renderer returns).
 * The service wraps them in an AudioBuffer, plays them through the same gate and volume as the built-in packs, and caches them.
 * A cue a pack cannot render is silent for that pack. An id must not match a built-in pack id.
 */
export interface CustomPack { id: string; label: string; description: string; render(cue: Cue, sampleRate: number): RenderedSound | null }

/** The original Legion recipe module (./lore/lore.js, written for Legion, no samples). It puts `LORE` on the global object when it loads. */
interface LoreApi { has(pack: string, cue: string): boolean; render(pack: string, cue: string, sampleRate: number): RenderedSound }
const lore = (globalThis as { LORE?: LoreApi }).LORE;
const lorePack = (id: string, label: string, description: string): CustomPack[] =>
  lore ? [{ id, label, description, render: (cue, sr) => (lore.has(id, cue) ? lore.render(id, cue, sr) : null) }] : [];

/** Forge and Reliquary come first in the picker, then the built-in packs. Add another pack by adding it here. */
export const CUSTOM_PACKS: readonly CustomPack[] = [
  ...lorePack('forge', 'Forge', 'Forge-temple machinery, iron and servos.'),
  ...lorePack('reliquary', 'Reliquary', 'A sacred hall of bells and choir.'),
];

export const DEFAULT_PACK = 'forge';
export const FALLBACK_PACK = 'minimal';

export function listPacks(custom: readonly CustomPack[] = CUSTOM_PACKS): SoundPackInfo[] {
  const built = PACKS.map((p) => ({ id: p.name as string, label: p.label as string, description: p.description as string, custom: false }));
  const ids = new Set(built.map((p) => p.id));
  return [...custom.filter((c) => !ids.has(c.id)).map((c) => ({ id: c.id, label: c.label, description: c.description, custom: true })), ...built];
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
