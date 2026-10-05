/** Shared helpers for the store specs. */
import type { StoragePort } from '../../../src/store/port.ts'

/** A clock that ticks one millisecond per call, shared by every session in a test (one machine, one clock). */
export function tickClock(start = 1_000): { now: () => number; set: (t: number) => void } {
  let t = start
  return { now: () => t++, set: v => (t = v) }
}

/** Wraps a port so a test can run code just before a chosen read or write lands. */
export function hookedPort(
  port: StoragePort,
  hooks: { beforeWrite?: (path: string, text: string) => Promise<void>; beforeRead?: (path: string) => Promise<void> },
): StoragePort {
  return {
    read: async p => {
      await hooks.beforeRead?.(p)
      return port.read(p)
    },
    write: async (p, t) => {
      await hooks.beforeWrite?.(p, t)
      return port.write(p, t)
    },
    list: d => port.list(d),
    stat: p => port.stat(p),
  }
}

export const key = (r: { s: string; q: number }): string => `${r.s}#${r.q}`
