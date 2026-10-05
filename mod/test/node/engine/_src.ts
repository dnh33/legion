/** Reads files of this worktree (desktop sources, vendored files, the mod's d.ts) for parity specs. Test-only; Node APIs allowed here. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A path relative to the worktree root (D:\bots\legion-mod). */
export function readRepo(rel: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', rel), 'utf8')
}

/** Evaluates one JavaScript string literal taken from a source file ('...' with \n and \' escapes). */
export function literal(src: string): string {
  // eslint-disable-next-line no-new-func
  return new Function(`return ${src}`)() as string
}

/** Every single-quoted string literal in `src`, evaluated, in order. */
export function stringLiterals(src: string): string[] {
  return [...src.matchAll(/'(?:[^'\\]|\\.)*'/g)].map((m) => literal(m[0]))
}

/** The text between the first `start` and the next `end` after it. Throws if either is missing, so a moved source fails loudly. */
export function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  if (i < 0) throw new Error(`marker not found: ${start}`)
  const j = src.indexOf(end, i + start.length)
  if (j < 0) throw new Error(`end marker not found after ${start}: ${end}`)
  return src.slice(i + start.length, j)
}
