/**
 * An in-memory StoragePort for tests. It behaves like `fsPort` over `$.fs` where the stores can tell: missing files read as
 * undefined, a missing folder lists as [], a write over MAX_FILE_BYTES rejects, and every path goes through safeRelPath.
 * Folders exist implicitly: a folder is any prefix of a stored file's path.
 */
import { MAX_FILE_BYTES, safeRelPath, type StorageEntry, type StoragePort } from './port.ts'
import { utf8Bytes } from './bytes.ts'

export type MemoryFile = { text: string; mtimeMs: number }

export type MemoryPort = StoragePort & {
  files: Map<string, MemoryFile>
  /** Calls per method, so a test can prove a refresh read nothing it did not need. */
  calls: { read: number; write: number; list: number; stat: number }
  /** Paths read, in order (reset it between steps of a test). */
  reads: string[]
}

export function memoryPort(opts: { now?: () => number } = {}): MemoryPort {
  const now = opts.now ?? (() => Date.now())
  const files = new Map<string, MemoryFile>()
  const calls = { read: 0, write: 0, list: 0, stat: 0 }
  const reads: string[] = []

  return {
    files,
    calls,
    reads,
    async read(path) {
      calls.read++
      const p = safeRelPath(path)
      reads.push(p)
      return files.get(p)?.text
    },
    async write(path, text) {
      calls.write++
      const p = safeRelPath(path)
      const bytes = utf8Bytes(text)
      if (bytes > MAX_FILE_BYTES) throw new Error(`storage: ${p} would be ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte file limit`)
      for (const [other] of files) {
        if (p.startsWith(`${other}/`)) throw new Error(`storage: ${other} is a file, not a folder`)
        if (other.startsWith(`${p}/`)) throw new Error(`storage: ${p} is a folder`)
      }
      files.set(p, { text, mtimeMs: now() })
    },
    async list(dir) {
      calls.list++
      const prefix = `${safeRelPath(dir)}/`
      const out = new Map<string, StorageEntry>()
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const cut = rest.indexOf('/')
        if (cut < 0) out.set(rest, { name: rest, kind: 'file', size: utf8Bytes(file.text), mtimeMs: file.mtimeMs })
        else {
          const name = rest.slice(0, cut)
          if (!out.has(name)) out.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0 })
        }
      }
      return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async stat(path) {
      calls.stat++
      const p = safeRelPath(path)
      const file = files.get(p)
      if (file) return { size: utf8Bytes(file.text), mtimeMs: file.mtimeMs }
      for (const other of files.keys()) if (other.startsWith(`${p}/`)) return { size: 0, mtimeMs: 0 }
      return undefined
    },
  }
}
