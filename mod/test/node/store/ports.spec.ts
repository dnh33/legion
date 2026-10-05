import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { FsEntry, FsStat } from 'claude-code'
import { memoryPort } from '../../../src/store/memory-port.ts'
import { fsPort, dataRoot, type FsLike } from '../../../src/store/fs-port.ts'
import { MAX_FILE_BYTES } from '../../../src/store/port.ts'
import { newId, sha1Hex, fnv1a32 } from '../../../src/store/ids.ts'

// ------------------------------------------------------------------------------------------------------------ memory port

test('memory port: missing file reads undefined, missing folder lists [], stat undefined', async () => {
  const port = memoryPort()
  assert.equal(await port.read('a/b.json'), undefined)
  assert.deepEqual(await port.list('a'), [])
  assert.equal(await port.stat('a/b.json'), undefined)
})

test('memory port: write, read, list (files and implied folders), stat', async () => {
  let t = 5
  const port = memoryPort({ now: () => t++ })
  await port.write('a/x.json', 'hé') // 3 bytes in UTF-8
  await port.write('a/sub/y.json', '1')
  assert.equal(await port.read('a/x.json'), 'hé')
  assert.deepEqual(await port.list('a'), [
    { name: 'sub', kind: 'dir', size: 0, mtimeMs: 0 },
    { name: 'x.json', kind: 'file', size: 3, mtimeMs: 5 },
  ])
  assert.deepEqual(await port.stat('a/x.json'), { size: 3, mtimeMs: 5 })
  assert.deepEqual(await port.stat('a/sub'), { size: 0, mtimeMs: 0 })
})

test('memory port: a write over MAX_FILE_BYTES rejects, counted in bytes not characters', async () => {
  const port = memoryPort()
  await port.write('ok.txt', 'a'.repeat(MAX_FILE_BYTES))
  await assert.rejects(port.write('big.txt', 'a'.repeat(MAX_FILE_BYTES + 1)), /over the 4194304-byte file limit/)
  // 'é' is 2 bytes: half the characters already fill the limit.
  await assert.rejects(port.write('wide.txt', 'é'.repeat(MAX_FILE_BYTES / 2 + 1)), /file limit/)
  assert.equal(await port.read('big.txt'), undefined)
})

test('memory port: refuses unsafe paths on every call', async () => {
  const port = memoryPort()
  for (const bad of ['', '/abs', 'C:/x', 'C:x', 'a\\b', '../x', 'a/../b', 'a//b', './a', 'a/']) {
    await assert.rejects(port.write(bad, 'x'), /storage:/, bad)
    await assert.rejects(port.read(bad), /storage:/, bad)
    await assert.rejects(port.list(bad), /storage:/, bad)
    await assert.rejects(port.stat(bad), /storage:/, bad)
  }
})

// ---------------------------------------------------------------------------------------------------------------- fs port

type Node = { kind: 'file'; text: string; mtimeMs: number } | { kind: 'dir' }

/** A fake `$.fs` with the documented behaviour: read and stat reject when missing; list rejects on a missing folder. */
function fakeFs(): FsLike & { nodes: Map<string, Node>; calls: string[]; failNext?: Error } {
  const nodes = new Map<string, Node>()
  const calls: string[] = []
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' })
  const self: FsLike & { nodes: Map<string, Node>; calls: string[]; failNext?: Error } = {
    nodes,
    calls,
    async read(p) {
      calls.push(`read ${p}`)
      if (self.failNext) throw self.failNext
      const n = nodes.get(p)
      if (!n) throw enoent(p)
      if (n.kind !== 'file') throw new Error('EISDIR')
      return n.text
    },
    async write(p, text) {
      calls.push(`write ${p}`)
      if (self.failNext) throw self.failNext
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/')
        if (d && !nodes.has(d)) nodes.set(d, { kind: 'dir' })
      }
      nodes.set(p, { kind: 'file', text, mtimeMs: 42 })
    },
    async list(p): Promise<FsEntry[]> {
      calls.push(`list ${p}`)
      if (self.failNext) throw self.failNext
      if (nodes.get(p)?.kind !== 'dir') throw enoent(p)
      const out: FsEntry[] = []
      for (const [path, n] of nodes) {
        if (!path.startsWith(`${p}/`) || path.slice(p.length + 1).includes('/')) continue
        out.push({ name: path.slice(p.length + 1), kind: n.kind, size: n.kind === 'file' ? Buffer.byteLength(n.text) : 0, mtimeMs: n.kind === 'file' ? n.mtimeMs : 0, isLink: false })
      }
      out.push({ name: 'a-link', kind: 'other', size: 0, mtimeMs: 0, isLink: true })
      return out
    },
    async stat(p): Promise<FsStat> {
      calls.push(`stat ${p}`)
      if (self.failNext) throw self.failNext
      const n = nodes.get(p)
      if (!n) throw enoent(p)
      return n.kind === 'file' ? { kind: 'file', size: Buffer.byteLength(n.text), mtimeMs: n.mtimeMs, isLink: false } : { kind: 'dir', size: 0, mtimeMs: 7, isLink: false }
    },
    async exists(p) {
      calls.push(`exists ${p}`)
      return nodes.has(p)
    },
  }
  return self
}

test('fs port: a missing file reads undefined and stats undefined; a missing folder lists []', async () => {
  const fs = fakeFs()
  const port = fsPort(fs, 'C:/Users/me/.legion-mod')
  assert.equal(await port.read('tasks/x.jsonl'), undefined)
  assert.equal(await port.stat('tasks/x.jsonl'), undefined)
  assert.deepEqual(await port.list('tasks'), [])
})

test('fs port: joins the root with "/", normalises backslashes and trailing separators, drops links', async () => {
  const fs = fakeFs()
  const port = fsPort(fs, 'C:\\Users\\me\\.legion-mod\\')
  await port.write('tasks/seg-a-0.jsonl', 'x\n')
  assert.deepEqual(fs.calls, ['write C:/Users/me/.legion-mod/tasks/seg-a-0.jsonl'])
  assert.equal(await port.read('tasks/seg-a-0.jsonl'), 'x\n')
  assert.deepEqual(await port.list('tasks'), [{ name: 'seg-a-0.jsonl', kind: 'file', size: 2, mtimeMs: 42 }])
  assert.deepEqual(await port.stat('tasks/seg-a-0.jsonl'), { size: 2, mtimeMs: 42 })
  const posix = fakeFs()
  await fsPort(posix, '/home/me/.legion-mod/').write('a.json', '{}')
  assert.deepEqual(posix.calls, ['write /home/me/.legion-mod/a.json'])
})

test('fs port: refuses escapes and relative roots before touching the file system', async () => {
  const fs = fakeFs()
  const port = fsPort(fs, '/root')
  for (const bad of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', '']) {
    await assert.rejects(port.read(bad), /storage:/, bad)
    await assert.rejects(port.write(bad, 'x'), /storage:/, bad)
  }
  assert.deepEqual(fs.calls, [])
  assert.throws(() => fsPort(fs, 'relative/root'), /absolute path/)
  assert.throws(() => fsPort(fs, ''), /absolute path/)
})

test('fs port: a real error (not a missing path) is rethrown, never swallowed', async () => {
  const fs = fakeFs()
  const port = fsPort(fs, '/root')
  await port.write('a/b.txt', 'x')
  fs.failNext = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  await assert.rejects(port.read('a/b.txt'), /EACCES/)
  await assert.rejects(port.stat('a/b.txt'), /EACCES/)
  await assert.rejects(port.list('a'), /EACCES/)
  await assert.rejects(port.write('a/b.txt', 'y'), /EACCES/)
})

test('fs port: a write over MAX_FILE_BYTES rejects before reaching $.fs', async () => {
  const fs = fakeFs()
  const port = fsPort(fs, '/root')
  await assert.rejects(port.write('big.txt', 'é'.repeat(MAX_FILE_BYTES / 2 + 1)), /file limit/)
  assert.deepEqual(fs.calls, [])
})

test('dataRoot: LEGION_MOD_HOME wins, else USERPROFILE, else HOME, under .legion-mod', () => {
  assert.equal(dataRoot({ LEGION_MOD_HOME: 'D:\\legion-data\\', USERPROFILE: 'C:\\Users\\me' }), 'D:/legion-data')
  assert.equal(dataRoot({ USERPROFILE: 'C:\\Users\\me', HOME: '/home/me' }), 'C:/Users/me/.legion-mod')
  assert.equal(dataRoot({ HOME: '/home/me/' }), '/home/me/.legion-mod')
  assert.equal(dataRoot({ LEGION_MOD_HOME: '  ', HOME: '/home/me' }), '/home/me/.legion-mod')
  assert.throws(() => dataRoot({}), /LEGION_MOD_HOME/)
  assert.throws(() => dataRoot({ LEGION_MOD_HOME: 'rel/dir' }), /absolute path/)
})

// -------------------------------------------------------------------------------------------------------------------- ids

test('newId: prefix, underscore, 12 lowercase hex (desktop parity), unique', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 500; i++) {
    const id = newId('t')
    assert.match(id, /^t_[0-9a-f]{12}$/)
    ids.add(id)
  }
  assert.equal(ids.size, 500)
})

test('sha1Hex equals node:crypto sha1 on the same UTF-8 text', async () => {
  for (const text of ['', 'abc', 'Zealot ✠ æøå', '😀'.repeat(50)]) {
    assert.equal(await sha1Hex(text), createHash('sha1').update(text).digest('hex'))
  }
})

test('fnv1a32: known vectors, 8 hex digits', () => {
  assert.equal(fnv1a32(''), '811c9dc5')
  assert.equal(fnv1a32('a'), 'e40c292c')
  assert.equal(fnv1a32('foobar'), 'bf9cf968')
  assert.match(fnv1a32('✠ Zealot'), /^[0-9a-f]{8}$/)
})
