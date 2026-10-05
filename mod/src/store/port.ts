/**
 * The storage port: the only way the mod's stores touch disk.
 *
 * Two adapters implement it: `fsPort($)` over Claude Code's `$.fs` (the mod at run time) and `memoryPort()` (tests, and a
 * Node temp-dir adapter for the ported desktop store tests). Paths are relative to the data root, `/`-separated, never `..`.
 *
 * `$.fs` has no append, delete, rename or lock, and a read or write over 4 MiB rejects (plan §2.3). The stores are built so
 * they need none of those: each session writes only its own files, and readers merge every session's files.
 */
export type StorageEntry = { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number }

export interface StoragePort {
  /** The file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>
  /** Writes the whole file, creating it and its folders. Callers keep each file under MAX_FILE_BYTES. */
  write(path: string, text: string): Promise<void>
  /** The entries of a folder, or [] when it does not exist. */
  list(dir: string): Promise<StorageEntry[]>
  /** Size and change time, or undefined when it does not exist. */
  stat(path: string): Promise<{ size: number; mtimeMs: number } | undefined>
}

/** Hard ceiling of `$.fs` (4 MiB). Stores roll their files well below it. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Rejects absolute paths, `..` and backslashes, so a store can never write outside the data root. */
export function safeRelPath(path: string): string {
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) throw new Error(`storage: not a relative path: ${path}`)
  const parts = path.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error(`storage: bad path segment in ${path}`)
  return path
}
