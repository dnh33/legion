/**
 * The StoragePort over Claude Code's `$.fs`, and the data root.
 *
 * `$.fs.read` and `$.fs.stat` reject when the path is missing (claude-code.d.ts, `fs.read` "Rejects when missing", `fs.stat`
 * "rejects `ENOENT` for a missing path"); the d.ts does not say what `list` does for a missing folder. So every call is tried
 * once, and only on a rejection does the port ask `exists`: missing becomes undefined / [], anything else is rethrown. The hot
 * path (a refresh every 2 s) stays one call per file, and no real error (a permission refusal, the 4 MiB cap) is swallowed.
 *
 * This module never sees `$`: the lead builds an FsLike from closures in register.tsx, e.g.
 *   fsPort({ read: p => $.fs.read(p), write: (p, t) => $.fs.write(p, t), list: p => $.fs.list(p),
 *            stat: p => $.fs.stat(p), exists: p => $.fs.exists(p) }, root)
 */
import type { FsEntry, FsStat } from 'claude-code'
import { MAX_FILE_BYTES, safeRelPath, type StorageEntry, type StoragePort } from './port.ts'
import { utf8Bytes } from './bytes.ts'

/** The part of `$.fs` the port uses (text reads only). */
export type FsLike = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  exists(path: string): Promise<boolean>
}

/** True for `/x`, `C:/x` and `C:\x`. A relative root would land in the person's project folder, so it is refused. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** `/`-separated, without a trailing separator (a bare drive keeps its colon: `C:`). */
function normalizeRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error(`storage: the data root must be an absolute path, got "${root}"`)
  return root.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function fsPort(fs: FsLike, root: string): StoragePort {
  const base = normalizeRoot(root)
  const full = (path: string): string => `${base}/${safeRelPath(path)}`

  /** Runs `op`; on a rejection, answers `missing` when the path is not there, else rethrows the original error. */
  async function orMissing<T, M>(path: string, op: () => Promise<T>, missing: M): Promise<T | M> {
    try {
      return await op()
    } catch (err) {
      let isThere: boolean
      try {
        isThere = await fs.exists(path)
      } catch {
        throw err
      }
      if (isThere) throw err
      return missing
    }
  }

  return {
    async read(path) {
      const p = full(path)
      return orMissing(p, () => fs.read(p), undefined)
    },
    async write(path, text) {
      const p = full(path)
      const bytes = utf8Bytes(text)
      if (bytes > MAX_FILE_BYTES) throw new Error(`storage: ${path} would be ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte file limit`)
      await fs.write(p, text)
    },
    async list(dir) {
      const p = full(dir)
      const entries = await orMissing(p, () => fs.list(p), [] as FsEntry[])
      const out: StorageEntry[] = []
      // Links (`other`) are left out: the stores never make one, and the port's kinds are file and dir only.
      for (const e of entries) if (e.kind === 'file' || e.kind === 'dir') out.push({ name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs })
      return out
    },
    async stat(path) {
      const p = full(path)
      const s = await orMissing(p, () => fs.stat(p), undefined)
      return s === undefined ? undefined : { size: s.size, mtimeMs: s.mtimeMs }
    },
  }
}

/**
 * Environment values the data root comes from. The caller reads each with a literal name (`$.env.get('HOME')`), because
 * `$.env.get` takes string literals only; a getter taking a name would not validate.
 */
export type DataRootEnv = { LEGION_MOD_HOME?: string | undefined; USERPROFILE?: string | undefined; HOME?: string | undefined }

/**
 * The mod's data root: LEGION_MOD_HOME when set, else `<USERPROFILE or HOME>/.legion-mod`. It sits outside the
 * desktop's `~/.legion`, so the two never write one file and the desktop uninstaller's purge of `~/.legion` leaves the
 * mod's data alone. Always absolute and `/`-separated; throws when nothing resolves.
 */
export function dataRoot(env: DataRootEnv): string {
  const pick = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== '' ? v.trim() : undefined)
  const own = pick(env.LEGION_MOD_HOME)
  if (own !== undefined) return normalizeRoot(own)
  const home = pick(env.USERPROFILE) ?? pick(env.HOME)
  if (home === undefined) throw new Error('storage: cannot find a home folder (neither USERPROFILE nor HOME is set). Set LEGION_MOD_HOME to an absolute folder.')
  return `${normalizeRoot(home)}/.legion-mod`
}
