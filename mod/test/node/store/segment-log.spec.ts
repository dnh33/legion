import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryPort } from '../../../src/store/memory-port.ts'
import { MAX_FILE_BYTES, type StoragePort } from '../../../src/store/port.ts'
import { checkSessionId, createSegmentLog, parseSegName, segName, type Fold, type LogRecord } from '../../../src/store/segment-log.ts'
import { hookedPort, key, tickClock } from './helpers.ts'

type Op = { k: string; v?: number; pad?: string }

/** Keeps the newest own record per key `k`. */
const keepLatest: Fold<Op> = mine => {
  const last = new Map<string, LogRecord<Op>>()
  for (const r of mine) last.set(r.op.k, r)
  return [...last.values()]
}

const ops = (rs: readonly LogRecord<Op>[]): string[] => rs.map(r => `${r.s}:${r.op.k}${r.op.v ?? ''}`)
/** Segment and gen files only (alive files are heartbeats). */
const dataFiles = (port: { files: Map<string, { text: string; mtimeMs: number }> }) => [...port.files.entries()].filter(([p]) => !/\/alive-/.test(p))

test('single session: append then a fresh log loads the same records in order', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSegmentLog<Op>(port, 'x', 'A', { now: clock.now })
  await a.append([{ k: 'a' }, { k: 'b' }])
  await a.append([])
  await a.append([{ k: 'c' }])
  assert.deepEqual(dataFiles(port).map(([p]) => p), ['x/seg-A-0.jsonl'])
  const again = await createSegmentLog<Op>(port, 'x', 'A', { now: clock.now }).load()
  assert.deepEqual(ops(again), ['A:a', 'A:b', 'A:c'])
  assert.deepEqual(again.map(r => r.q), [0, 1, 2])
  assert.deepEqual(ops(a.all()), ['A:a', 'A:b', 'A:c'])
})

test('two sessions interleaved: every reader merges by (t, s, q)', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSegmentLog<Op>(port, 'x', 'A', { now: clock.now })
  const b = createSegmentLog<Op>(port, 'x', 'B', { now: clock.now })
  await a.append([{ k: 'a', v: 1 }])
  await b.append([{ k: 'b', v: 1 }])
  await a.append([{ k: 'a', v: 2 }])
  await b.append([{ k: 'b', v: 2 }, { k: 'b', v: 3 }]) // one batch: same t, ordered by q
  clock.set(10_000)
  await b.append([{ k: 'b', v: 4 }])
  clock.set(10_000) // same t in both sessions: s breaks the tie
  await a.append([{ k: 'a', v: 3 }])
  const c = createSegmentLog<Op>(port, 'x', 'C', { now: clock.now })
  assert.deepEqual(ops(await c.load()), ['A:a1', 'B:b1', 'A:a2', 'B:b2', 'B:b3', 'A:a3', 'B:b4'])
  assert.deepEqual(ops(await b.refresh()), ops(c.all()), 'a refresh before any load is a load: everything is new')
  assert.deepEqual(await b.refresh(), [])
  assert.deepEqual(ops(b.all()), ops(c.all()))
})

test('torn last line: skipped and counted, then read once the writer finishes it', async () => {
  const port = memoryPort()
  const good = (q: number, k: string): string => JSON.stringify({ s: 'B', q, t: 100 + q, op: { k } })
  await port.write('x/seg-B-0.jsonl', `${good(0, 'a')}\nnot json\n${good(1, 'b')}\n${good(2, 'c').slice(0, 20)}`)
  const r = createSegmentLog<Op>(port, 'x', 'R')
  assert.deepEqual(ops(await r.load()), ['B:a', 'B:b'])
  assert.equal(r.skipped, 2, 'one unparsable complete line plus one torn fragment')
  await port.write('x/seg-B-0.jsonl', `${good(0, 'a')}\nnot json\n${good(1, 'b')}\n${good(2, 'c')}\n`)
  assert.deepEqual(ops(await r.refresh()), ['B:c'])
  assert.equal(r.skipped, 1, 'the finished line no longer counts')
  assert.deepEqual(ops(r.all()), ['B:a', 'B:b', 'B:c'])
})

test('a record whose s differs from its file name, or with a bad q or t, is skipped', async () => {
  const port = memoryPort()
  const lines = [
    { s: 'B', q: 0, t: 1, op: { k: 'ok' } },
    { s: 'A', q: 1, t: 1, op: { k: 'spoof' } },
    { s: 'B', q: -1, t: 1, op: { k: 'neg' } },
    { s: 'B', q: 2, t: 'x', op: { k: 'badt' } },
    { s: 'B', q: 3, t: 1 },
    [1, 2],
  ]
  await port.write('x/seg-B-0.jsonl', lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const r = createSegmentLog<Op>(port, 'x', 'R')
  assert.deepEqual(ops(await r.load()), ['B:ok'])
  assert.equal(r.skipped, 5)
})

test('roll at threshold: no file passes rollBytes; an oversized record goes alone; over 4 MiB throws', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A', { rollBytes: 200, now: tickClock().now })
  for (let i = 0; i < 10; i++) await a.append([{ k: `r${i}`, pad: 'é'.repeat(20) }]) // ~90 bytes each, multibyte
  const sizes = dataFiles(port).map(([p, f]) => [p, new TextEncoder().encode(f.text).length] as const)
  assert.ok(sizes.length >= 5, `rolled into ${sizes.length} files`)
  for (const [p, n] of sizes) assert.ok(n <= 200, `${p} is ${n} bytes`)
  assert.deepEqual(
    sizes.map(([p]) => p),
    sizes.map((_, i) => `x/seg-A-${i}.jsonl`),
  )
  await a.append([{ k: 'big', pad: 'x'.repeat(500) }])
  const last = dataFiles(port).at(-1)!
  assert.equal(last[1].text.split('\n').length - 1, 1, 'the oversized record sits alone')
  await a.append([{ k: 'after' }])
  assert.ok(port.files.get(`x/seg-A-${sizes.length + 1}.jsonl`), 'the next record starts a new file')
  await assert.rejects(a.append([{ k: 'huge', pad: 'x'.repeat(MAX_FILE_BYTES) }]), /over the 4194304-byte file limit/)
  assert.equal((await createSegmentLog<Op>(port, 'x', 'R').load()).length, 12)
})

test('a batch that crosses the threshold splits across files and keeps its order', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A', { rollBytes: 150 })
  await a.append(Array.from({ length: 6 }, (_, i) => ({ k: `k${i}` })))
  assert.ok(dataFiles(port).length > 1)
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R').load()), ['A:k0', 'A:k1', 'A:k2', 'A:k3', 'A:k4', 'A:k5'])
})

test('refresh returns only new records and re-reads nothing unchanged', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSegmentLog<Op>(port, 'x', 'A', { rollBytes: 200, now: clock.now })
  const b = createSegmentLog<Op>(port, 'x', 'B', { now: clock.now })
  for (let i = 0; i < 6; i++) await a.append([{ k: `a${i}`, pad: '-'.repeat(40) }])
  await b.append([{ k: 'b0' }])
  const r = createSegmentLog<Op>(port, 'x', 'R', { now: clock.now })
  assert.equal((await r.load()).length, 7)

  port.reads.length = 0
  const lists = port.calls.list
  assert.deepEqual(await r.refresh(), [])
  assert.deepEqual(port.reads, [], 'nothing changed: no file read')
  assert.equal(port.calls.list, lists + 1, 'one folder listing')

  await a.append([{ k: 'a6', pad: '-'.repeat(40) }])
  port.reads.length = 0
  assert.deepEqual(ops(await r.refresh()), ['A:a6'])
  assert.equal(port.reads.length, 1, 'only the changed file is read')
  assert.match(port.reads[0]!, /^x\/seg-A-\d+\.jsonl$/)

  port.reads.length = 0
  assert.deepEqual(await r.refresh(), [])
  assert.deepEqual(port.reads, [])
  assert.deepEqual(ops(r.all()), ops(await createSegmentLog<Op>(port, 'x', 'Z').load()))
})

test('a file that shrank (caught mid-rewrite) triggers a reload that loses nothing and duplicates nothing', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await a.append([{ k: 'a' }, { k: 'b' }])
  const r = createSegmentLog<Op>(port, 'x', 'R')
  await r.load()
  const text = port.files.get('x/seg-A-0.jsonl')!.text
  await port.write('x/seg-A-0.jsonl', text.split('\n')[0] + '\n') // caught mid-rewrite: shorter
  assert.deepEqual(await r.refresh(), [])
  assert.deepEqual(ops(r.all()), ['A:a', 'A:b'], 'records already read stay: within one generation files only grow')
  await port.write('x/seg-A-0.jsonl', text)
  assert.deepEqual(await r.refresh(), [], 'the finished rewrite hands nothing out twice')
  await a.append([{ k: 'c' }])
  assert.deepEqual(ops(await r.refresh()), ['A:c'])
  assert.deepEqual(ops(r.all()), ['A:a', 'A:b', 'A:c'])
})

test('a compaction the gen file does not reveal (same size, same time) is still caught by its blanked segments', async () => {
  const port = memoryPort({ now: () => 5 }) // every write gets the same mtime
  const a = createSegmentLog<Op>(port, 'x', 'A', { now: () => 100 })
  const keepLatest1: Fold<Op> = mine => [...new Map(mine.map(r => [r.op.k, r] as const)).values()]
  await a.append([{ k: 'p', v: 1 }, { k: 'q', v: 1 }])
  await a.compactOwn(keepLatest1)
  const r = createSegmentLog<Op>(port, 'x', 'R', { now: () => 100 })
  await r.load()
  await a.append([{ k: 'p', v: 2 }])
  assert.deepEqual(ops(await r.refresh()), ['A:p2'])
  const genBefore = port.files.get('x/gen-A.json')!.text
  await a.compactOwn(keepLatest1)
  assert.equal(port.files.get('x/gen-A.json')!.text.length, genBefore.length, 'the gen file kept its size')
  await a.append([{ k: 'r', v: 1 }])
  assert.deepEqual(ops(await r.refresh()), ['A:r1'])
  assert.deepEqual(ops(r.all()), ops(await createSegmentLog<Op>(port, 'x', 'Z').load()))
})

test('q is monotonic across a reopen, and the writer continues its last clean segment', async () => {
  const port = memoryPort()
  await createSegmentLog<Op>(port, 'x', 'A').append([{ k: 'a' }, { k: 'b' }, { k: 'c' }])
  const again = createSegmentLog<Op>(port, 'x', 'A')
  await again.append([{ k: 'd' }]) // without an explicit load
  const recs = await createSegmentLog<Op>(port, 'x', 'R').load()
  assert.deepEqual(recs.map(r => r.q), [0, 1, 2, 3])
  assert.deepEqual(dataFiles(port).map(([p]) => p), ['x/seg-A-0.jsonl'], 'no new file per restart')
})

test('a torn own segment is left alone: the reopened writer starts a new file', async () => {
  const port = memoryPort()
  await createSegmentLog<Op>(port, 'x', 'A').append([{ k: 'a' }])
  const f = port.files.get('x/seg-A-0.jsonl')!
  await port.write('x/seg-A-0.jsonl', `${f.text}{"s":"A","q":1,"t`)
  const again = createSegmentLog<Op>(port, 'x', 'A')
  await again.append([{ k: 'b' }])
  assert.ok(port.files.get('x/seg-A-1.jsonl'))
  const recs = await createSegmentLog<Op>(port, 'x', 'R').load()
  assert.deepEqual(ops(recs), ['A:a', 'A:b'])
  assert.equal(recs[1]!.q, 1)
})

test('q stays monotonic after a compaction drops the newest record (gen file keeps maxQ)', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await a.append([{ k: 'keep' }, { k: 'drop' }, { k: 'drop' }])
  await a.compactOwn(mine => mine.filter(r => r.op.k === 'keep'))
  const reopened = createSegmentLog<Op>(port, 'x', 'A')
  await reopened.append([{ k: 'next' }])
  const recs = await createSegmentLog<Op>(port, 'x', 'R').load()
  assert.deepEqual(recs.map(r => [r.op.k, r.q]), [['keep', 0], ['next', 3]])
})

test('compaction keeps original stamps: a stale own record never beats a newer edit from another window', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSegmentLog<Op>(port, 'x', 'A', { now: clock.now })
  const b = createSegmentLog<Op>(port, 'x', 'B', { now: clock.now })
  await a.append([{ k: 'X', v: 1 }])
  await b.append([{ k: 'X', v: 2 }])
  await a.compactOwn(keepLatest)
  const recs = await createSegmentLog<Op>(port, 'x', 'R', { now: clock.now }).load()
  const lastX = recs.filter(r => r.op.k === 'X').at(-1)!
  assert.equal(lastX.op.v, 2)
})

test('compactOwn writes a new generation, names it in the gen file, and blanks the old segments', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A', { rollBytes: 120 })
  for (let i = 0; i < 6; i++) await a.append([{ k: i % 2 ? 'odd' : 'even', v: i }])
  const before = dataFiles(port).map(([p]) => p)
  await a.compactOwn(keepLatest)
  for (const p of before) assert.equal(port.files.get(p)!.text, '', `${p} blanked`)
  const gen = JSON.parse(port.files.get('x/gen-A.json')!.text)
  assert.equal(gen.gen, 1)
  assert.deepEqual(gen.segments, ['seg-A-g1-0.jsonl'])
  assert.equal(gen.maxQ, 5)
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R').load()), ['A:even4', 'A:odd5'])
  await a.append([{ k: 'new' }])
  const g1 = dataFiles(port).map(([p]) => p).filter(p => p.startsWith('x/seg-A-g1-'))
  assert.ok(g1.some(p => port.files.get(p)!.text.includes('"new"')), 'appends continue in the new generation')
  await a.compactOwn(keepLatest)
  assert.equal(JSON.parse(port.files.get('x/gen-A.json')!.text).gen, 2)
  for (const p of g1) assert.equal(port.files.get(p)!.text, '', `${p} blanked by the second compaction`)
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R2').load()), ['A:even4', 'A:odd5', 'A:new'])
})

test('compaction while another reader holds stale offsets: no loss, no duplicates, at every step of the race', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const r = createSegmentLog<Op>(port, 'x', 'R', { now: clock.now })
  const seen: string[] = []
  const snapshot = async (label: string): Promise<void> => {
    for (const rec of await r.refresh()) seen.push(key(rec))
    const fresh = await createSegmentLog<Op>(port, 'x', `Z${label}`, { now: clock.now }).load()
    assert.deepEqual(ops(r.all()), ops(fresh), `reader view equals a fresh load ${label}`)
  }
  // The compacting window's writes pause before each write lands, and the reader refreshes right there.
  let step = 0
  let isCompacting = false
  const aPort = hookedPort(port, { beforeWrite: async () => (isCompacting ? snapshot(`step${step++}`) : undefined) })
  const a = createSegmentLog<Op>(aPort, 'x', 'A', { rollBytes: 150, now: clock.now })
  await a.append([{ k: 'p', v: 1 }, { k: 'q', v: 1 }])
  await r.load().then(rs => rs.forEach(rec => seen.push(key(rec))))
  await a.append([{ k: 'p', v: 2 }, { k: 'r', v: 1 }]) // the reader has not seen these yet
  isCompacting = true
  await a.compactOwn(keepLatest)
  isCompacting = false
  assert.ok(step >= 3, `the reader refreshed at ${step} points inside the compaction`)
  await snapshot('after')
  assert.equal(new Set(seen).size, seen.length, `no record handed out twice: ${seen.join(' ')}`)
  for (const rec of r.all()) assert.ok(seen.includes(key(rec)), `${key(rec)} reached the reader`)
  assert.deepEqual(ops(r.all()), ['A:q1', 'A:p2', 'A:r1'])
})

test('a reader whose reload races a compaction redoes the reload and ends correct', async () => {
  const port = memoryPort()
  const clock = tickClock()
  const a = createSegmentLog<Op>(port, 'x', 'A', { now: clock.now })
  await a.append([{ k: 'p', v: 1 }, { k: 'p', v: 2 }, { k: 'q', v: 1 }])
  let isArmed = true
  const rPort = hookedPort(port, {
    beforeRead: async p => {
      if (isArmed && p === 'x/seg-A-0.jsonl') {
        isArmed = false
        await a.compactOwn(keepLatest) // lands between the reader's gen read and its segment read
      }
    },
  })
  const r = createSegmentLog<Op>(rPort, 'x', 'R', { now: clock.now })
  const got = await r.load()
  assert.equal(isArmed, false)
  assert.deepEqual(ops(got), ['A:p2', 'A:q1'])
})

test('readers ignore a new generation until its gen file names it, and a crashed compaction is finished on reopen', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await a.append([{ k: 'a' }, { k: 'a' }])
  // A compaction that stopped after writing its segment, before the gen flip:
  await port.write('x/seg-A-g1-0.jsonl', `${JSON.stringify({ s: 'A', q: 1, t: 1, op: { k: 'a' } })}\n`)
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R').load()), ['A:a', 'A:a'])
  // ... and one that stopped after the flip, before blanking:
  await port.write('x/gen-A.json', JSON.stringify({ gen: 1, segments: ['seg-A-g1-0.jsonl'], maxQ: 1, maxT: 1 }))
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R2').load()), ['A:a'])
  // A torn gen file: the highest generation with content is taken as live, and the doctor counter shows it.
  const genText = port.files.get('x/gen-A.json')!.text
  await port.write('x/gen-A.json', genText.slice(0, 10))
  const torn = createSegmentLog<Op>(port, 'x', 'R4')
  assert.deepEqual(ops(await torn.load()), ['A:a'])
  assert.equal(torn.skipped, 1)
  await port.write('x/gen-A.json', genText)
  // A later generation's segment is not live until the gen file names it, even with a q past maxQ.
  await port.write('x/seg-A-g2-0.jsonl', `${JSON.stringify({ s: 'A', q: 7, t: 1, op: { k: 'future' } })}
`)
  assert.deepEqual(ops(await createSegmentLog<Op>(port, 'x', 'R5').load()), ['A:a'])
  await port.write('x/seg-A-g2-0.jsonl', '')
  const reopened = createSegmentLog<Op>(port, 'x', 'A')
  await reopened.load()
  assert.equal(port.files.get('x/seg-A-0.jsonl')!.text, '', 'the superseded segment is blanked on reopen')
  await reopened.append([{ k: 'b' }])
  assert.deepEqual((await createSegmentLog<Op>(port, 'x', 'R3').load()).map(r => r.q), [1, 2])
  // A newer compaction never reuses the leftover generation's names.
  await port.write('x/seg-A-g5-0.jsonl', '')
  await reopened.compactOwn(keepLatest)
  assert.equal(JSON.parse(port.files.get('x/gen-A.json')!.text).gen, 6)
})

test('a fold that invents or restamps records is refused, and nothing is written', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await a.append([{ k: 'a' }])
  const writes = port.calls.write
  await assert.rejects(a.compactOwn(mine => mine.map(r => ({ ...r, t: r.t + 1 }))), /taken from its own input/)
  await assert.rejects(a.compactOwn(() => [{ s: 'A', q: 99, t: 1, op: { k: 'x' } }]), /taken from its own input/)
  await assert.rejects(a.compactOwn(mine => [...mine, ...mine]), /each once/)
  assert.equal(port.calls.write, writes)
})

test('appends that overlap in time are serialized: none is lost', async () => {
  const port = memoryPort()
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await Promise.all(Array.from({ length: 20 }, (_, i) => a.append([{ k: `k${i}` }])))
  const recs = await createSegmentLog<Op>(port, 'x', 'R').load()
  assert.equal(recs.length, 20)
  assert.deepEqual(recs.map(r => r.q), Array.from({ length: 20 }, (_, i) => i))
})

test('a failed write never reuses a q and the next append starts a fresh file', async () => {
  const mem = memoryPort()
  let isFailing = false
  const port = hookedPort(mem, { beforeWrite: async () => { if (isFailing) throw new Error('EIO: disk said no') } })
  const a = createSegmentLog<Op>(port, 'x', 'A')
  await a.append([{ k: 'a' }])
  isFailing = true
  await assert.rejects(a.append([{ k: 'lost' }]), /EIO/)
  isFailing = false
  await a.append([{ k: 'b' }])
  const recs = await createSegmentLog<Op>(mem, 'x', 'R').load()
  assert.deepEqual(recs.map(r => [r.op.k, r.q]), [['a', 0], ['b', 2]])
  assert.ok(mem.files.get('x/seg-A-1.jsonl'))
})

test('session ids and segment names: one reading per file name', () => {
  for (const ok of ['A', 'abc_1', '3f2b1c9e-7a44-4d0e-9a51-0f0c2b8e1d22', 'g2', 'a-gx', 'a-12']) assert.equal(checkSessionId(ok), ok)
  for (const bad of ['', 'a/b', 'a.b', 'a-g2', 'x-g10-y', 'a--b', '-a', 'x'.repeat(129)]) assert.throws(() => checkSessionId(bad), /session id/, bad)
  for (const [s, gen, n] of [['a-12', 0, 3], ['abc', 2, 0], ['3f2b1c9e-7a44', 11, 7], ['g2', 0, 0], ['g2', 1, 1]] as const) {
    assert.deepEqual(parseSegName(segName(s, gen, n)), { s, gen, n })
  }
  assert.equal(parseSegName('gen-a.json'), undefined)
  assert.equal(parseSegName('seg-a.jsonl'), undefined)
})

// ------------------------------------------------------------------------------------------------- dead-writer adoption

const DAY = 24 * 60 * 60 * 1000
const keepAll: Fold<Op> = mine => mine
/** Lines in data files whose record has session `s`. */
const linesOf = (port: { files: Map<string, { text: string; mtimeMs: number }> }, s: string): number =>
  dataFiles(port).flatMap(([, f]) => f.text.split('\n').filter(l => l.includes(`"s":"${s}"`))).length

/** One clock for the port's mtimes and every log, so "24 h later" means the same thing to both. */
function world() {
  const clock = tickClock()
  const port = memoryPort({ now: clock.now })
  const log = (s: string, p: StoragePort = port) => createSegmentLog<Op>(p, 'x', s, { now: clock.now })
  return { clock, port, log, later: () => clock.set(clock.now() + DAY + 60_000) }
}

test('heartbeat: writes alive-<sid>.json at most once a minute, also from append', async () => {
  const { clock, port, log } = world()
  const a = log('A')
  await a.heartbeat()
  const first = JSON.parse(port.files.get('x/alive-A.json')!.text).at
  const writes = port.calls.write
  await a.heartbeat()
  await a.append([{ k: 'a' }])
  assert.equal(port.calls.write, writes + 1, 'only the segment was written')
  clock.set(first + 61_000)
  await a.append([{ k: 'b' }])
  assert.ok(JSON.parse(port.files.get('x/alive-A.json')!.text).at >= first + 61_000)
})

test('a dead writer is adopted: its records move into the adopter with their stamps, its gen file names the adopter', async () => {
  const { port, log, later } = world()
  const d = log('D')
  await d.append([{ k: 'p', v: 1 }, { k: 'q', v: 1 }])
  const a = log('A')
  await a.append([{ k: 'a', v: 1 }])
  const r = log('R')
  const before = await r.load()
  later()
  await a.heartbeat()
  await a.compactOwn(keepAll)
  const gen = JSON.parse(port.files.get('x/gen-D.json')!.text)
  assert.deepEqual([gen.gen, gen.segments, gen.adoptedBy, gen.maxQ], [1, [], 'A', 1])
  assert.equal(port.files.get('x/seg-D-0.jsonl')!.text, '', "the dead writer's segment is blanked")
  assert.equal(linesOf(port, 'D'), 2, "D's records now live in A's files")
  assert.deepEqual(await log('Z').load(), before, 'same records, same (s, q, t)')
  assert.deepEqual(await r.refresh(), [], 'moved, not new')
  assert.deepEqual(r.all(), before)
})

test("a writer silent under 24 h is not adopted; with no alive file its files' age decides", async () => {
  const { clock, port, log } = world()
  const d = log('D')
  await d.append([{ k: 'p' }])
  const a = log('A')
  await a.append([{ k: 'a' }])
  clock.set(clock.now() + DAY - 60_000)
  await a.compactOwn(keepAll)
  assert.equal(linesOf(port, 'D'), 1)
  assert.equal(port.files.has('x/gen-D.json'), false, 'not adopted: alive 23 h 59 min ago')
  port.files.delete('x/alive-D.json')
  await a.compactOwn(keepAll)
  assert.equal(port.files.has('x/gen-D.json'), false, 'no alive file, files under 24 h old')
  clock.set(clock.now() + 2 * 60_000)
  await a.compactOwn(keepAll)
  assert.equal(JSON.parse(port.files.get('x/gen-D.json')!.text).adoptedBy, 'A')
})

test('two windows adopting the same dead writer at once: copies collapse on read, then one holder keeps them', async () => {
  const { port, log, later } = world()
  const d = log('D')
  await d.append([{ k: 'p' }, { k: 'q' }, { k: 'r' }])
  const b = log('B')
  await b.append([{ k: 'b' }])
  let isArmed = true
  const aPort = hookedPort(port, {
    beforeWrite: async p => {
      if (isArmed && p.startsWith('x/seg-A-g')) {
        isArmed = false
        await b.compactOwn(keepAll) // B adopts D while A is between reading D and writing its own generation
      }
    },
  })
  const a = log('A', aPort)
  await a.append([{ k: 'a' }])
  later()
  await a.heartbeat()
  await b.heartbeat()
  const expected = ['A:a', 'B:b', 'D:p', 'D:q', 'D:r'].sort()
  await a.compactOwn(keepAll)
  assert.equal(isArmed, false)
  assert.equal(linesOf(port, 'D'), 6, "both A and B hold D's three records")
  assert.deepEqual(ops(await log('Z').load()).sort(), expected, 'each record once')
  await b.compactOwn(keepAll) // B sees that A (A < B) holds them: B leaves them to A
  await a.compactOwn(keepAll)
  assert.equal(linesOf(port, 'D'), 3)
  assert.deepEqual(ops(await log('Z2').load()).sort(), expected)
})

test('an adopted writer that comes back (resume, or a window that slept) loses nothing and keeps q monotonic', async () => {
  const { port, log, later } = world()
  const d = log('D')
  await d.append([{ k: 'p' }, { k: 'q' }])
  const a = log('A')
  await a.append([{ k: 'a' }])
  await d.load()
  later()
  await a.heartbeat()
  await a.compactOwn(keepAll)
  // The same window wakes up with its old in-memory state:
  await d.append([{ k: 'woke' }])
  assert.ok(port.files.get('x/seg-D-g1-0.jsonl')!.text.includes('"woke"'), 'a fresh generation')
  assert.deepEqual(ops(d.all()).sort(), ['A:a', 'D:p', 'D:q', 'D:woke'], 'its own moved records never blink out')
  assert.deepEqual(await d.refresh(), [], 'and are not handed out again')
  // ... and later a resumed session with the same id:
  const resumed = log('D')
  await resumed.append([{ k: 'resumed' }])
  const recs = await log('Z').load()
  assert.deepEqual(ops(recs).sort(), ['A:a', 'D:p', 'D:q', 'D:resumed', 'D:woke'])
  assert.deepEqual(recs.filter(x => x.s === 'D').map(x => x.q).sort(), [0, 1, 2, 3])
})

test('a record the adopted writer wrote while being adopted still counts, and moves into its live generation', async () => {
  const { port, log, later } = world()
  const a = log('A')
  await a.append([{ k: 'a' }])
  let isArmed = false
  const dPort = hookedPort(port, {
    beforeWrite: async p => {
      if (isArmed && p === 'x/seg-D-0.jsonl') {
        isArmed = false
        await a.compactOwn(keepAll) // D checked its gen file, then A adopted D before D's write landed
      }
    },
  })
  const d = log('D', dPort)
  await d.append([{ k: 'p' }, { k: 'q' }])
  later()
  await a.heartbeat()
  isArmed = true
  await d.append([{ k: 'late' }])
  assert.equal(JSON.parse(port.files.get('x/gen-D.json')!.text).maxQ, 1)
  assert.ok(port.files.get('x/seg-D-0.jsonl')!.text.includes('"late"'), 'the late write landed in a superseded file')
  const r = log('R')
  assert.deepEqual(ops(await r.load()).sort(), ['A:a', 'D:late', 'D:p', 'D:q'], 'counted once, nothing lost')
  await d.append([{ k: 'next' }])
  assert.equal(port.files.get('x/seg-D-0.jsonl')!.text, '', 'salvaged, then blanked')
  assert.deepEqual(ops(await r.refresh()), ['D:next'])
  assert.deepEqual(ops(r.all()).sort(), ['A:a', 'D:late', 'D:next', 'D:p', 'D:q'])
  assert.deepEqual(ops(await log('Z').load()), ops(r.all()))
})

test('a reader refreshing at every step of an adoption never loses or repeats a record', async () => {
  const { port, log, later } = world()
  const d = log('D')
  await d.append([{ k: 'p', v: 1 }, { k: 'q', v: 1 }])
  const r = log('R')
  const seen: string[] = []
  let step = 0
  let isCompacting = false
  const aPort = hookedPort(port, {
    beforeWrite: async () => {
      if (!isCompacting) return
      for (const rec of await r.refresh()) seen.push(key(rec))
      assert.deepEqual(ops(r.all()), ops(await log(`Z${step}`).load()), `step ${step}`)
      step++
    },
  })
  const a = log('A', aPort)
  await a.append([{ k: 'a', v: 1 }])
  for (const rec of await r.load()) seen.push(key(rec))
  await d.append([{ k: 'p', v: 2 }]) // not seen by the reader yet
  later()
  await a.heartbeat()
  isCompacting = true
  await a.compactOwn(keepAll)
  isCompacting = false
  for (const rec of await r.refresh()) seen.push(key(rec))
  assert.ok(step >= 4, `${step} steps`)
  assert.equal(new Set(seen).size, seen.length, seen.join(' '))
  assert.deepEqual(new Set(seen), new Set(r.all().map(key)))
  assert.equal(r.all().length, 4)
})

test('load lists the folder once, however many sessions there are', async () => {
  const { port, log } = world()
  for (const s of ['A', 'B', 'C', 'D']) await log(s).append([{ k: s }])
  await log('A').compactOwn(keepAll)
  const lists = port.calls.list
  assert.equal((await log('R').load()).length, 4)
  assert.equal(port.calls.list - lists, 1)
})
