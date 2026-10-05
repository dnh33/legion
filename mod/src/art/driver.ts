/**
 * The 2D Order's one entry point for the lead: animator + compose + pack. Pure apart from the caches it keeps on the objects
 * it is given. The lead's wiring (plan section 5): when the 2D Order is on and a stage shows, call `stepStage`; blit the cells
 * only when they are not null; schedule one `$.clock.after` at `nextAtMs` (none when it is null). When it is off, nothing in
 * mod/src/art is imported and no frame is loaded.
 */
import type { Mood } from '../../types/index.d.ts'
import type { Art } from './art.ts'
import { createAnimState, stillPose, tick, type AnimInput, type AnimState } from './animator.ts'
import { compose } from './compose.ts'
import { pack, type PackOptions } from './pack.ts'

export type StageRuntime = { art: Art; anim: AnimState; pack: PackOptions }

export type StageOptions = PackOptions & {
  /** The 1 px outline around the figure (default on; it is a darker shade of the art's own colours). */
  outline?: boolean
  seed?: number
}

export function createStage(art: Art, now: number, mood: Mood, opts: StageOptions): StageRuntime {
  const { outline, seed, ...packOpts } = opts
  return { art, anim: createAnimState(art, now, mood, { ...(seed !== undefined ? { seed } : {}), outline: outline ?? true }), pack: packOpts }
}

/** One step of the shown stage: the new cells (null: nothing changed, do not blit) and when to call again (null: not until an event). */
export function stepStage(rt: StageRuntime, now: number, input: AnimInput): { cells: string | null; nextAtMs: number | null } {
  const r = tick(rt.art, rt.anim, now, input)
  rt.anim = r.state
  return { cells: r.pose ? pack(compose(rt.art.stage, r.pose), rt.pack) : null, nextAtMs: r.nextAtMs }
}

/** Forces the next step to draw (after a remount or a theme change, when the Raster lost its cells). */
export function invalidateStage(rt: StageRuntime): void {
  rt.anim = { ...rt.anim, lastKey: null }
}

const musterCache = new WeakMap<Art, Map<string, string>>()

/** The muster row's still frame of a mood (rail busts never animate on the desktop either). Cached per art, mood and options. */
export function musterCells(art: Art, mood: Mood, opts: StageOptions): string {
  let m = musterCache.get(art)
  if (!m) { m = new Map(); musterCache.set(art, m) }
  const key = `${mood}|${opts.panel}|${opts.transparent ?? 'panel'}|${opts.outline ?? true}`
  const hit = m.get(key)
  if (hit) return hit
  const cells = pack(compose(art.muster, stillPose(art, mood, opts.outline ?? true)), { panel: opts.panel, ...(opts.transparent ? { transparent: opts.transparent } : {}) })
  m.set(key, cells)
  return cells
}

/** A still stage frame (motion off, tests, review). */
export function stillStageCells(art: Art, mood: Mood, opts: StageOptions): string {
  return pack(compose(art.stage, stillPose(art, mood, opts.outline ?? true)), { panel: opts.panel, ...(opts.transparent ? { transparent: opts.transparent } : {}) })
}
