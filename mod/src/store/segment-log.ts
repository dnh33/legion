/**
 * A lock-free append log that many terminal windows share (plan §2.3).
 *
 * `$.fs` has no append, delete, rename or lock. So:
 * - Each session writes only its own files: `<dir>/seg-<sessionId>-<n>.jsonl` (generation 0) or
 *   `<dir>/seg-<sessionId>-g<gen>-<n>.jsonl` (after a compaction), one JSON record per line. Appends keep the current own
 *   segment in memory and rewrite it whole, rolling to n+1 before a file would pass `rollBytes`.
 * - Readers merge every session's live records, deduped by (s, q) and ordered by (t, s, q).
 * - A session compacts its own records: it writes the kept records as a new generation, then flips its own
 *   `<dir>/gen-<sessionId>.json`, then blanks the superseded segments (there is no delete).
 * - Dead-writer adoption: every live session rewrites `<dir>/alive-<sessionId>.json` at most once a minute. A writer whose
 *   alive file is over 24 h old (or, with no alive file, whose newest file is) is dead in this folder. A compacting session
 *   folds a dead writer's live records into its own new generation (stamps kept), then writes the dead writer's gen file as
 *   `{ gen: prev+1, segments: [], adoptedBy, adopterGen, maxQ }` and blanks its segments. Two windows adopting the same
 *   writer at once only make copies with equal (s, q), which collapse on read; a later compaction keeps the copy of the
 *   holder with the smallest session id.
 *
 * Why readers never lose or duplicate a record:
 * - Compaction and adoption keep each record's original (s, q, t), so a moved record is the same record by (s, q), and
 *   last-writer-wins across windows is unchanged. `refresh` answers the records whose (s, q) was not in the view before.
 * - New-generation segments carry the gen in their name; until the gen file names that gen, readers ignore them.
 * - A session is (re)loaded as: list the folder, read the gen file, read the segments, stat the gen file again; a changed
 *   gen file means a compaction ran in between, so the load is redone. Blanking happens only after the gen file flips.
 * - An adopted writer's gen file names its adopter's generation; a reader whose view of the adopter is older reloads the
 *   adopter in the same pass (the adopter flips its own gen file first), so moved records never blink out.
 * - Within one generation files only grow, so a reload in the same generation (a file caught mid-rewrite) keeps what was
 *   already read. Line offsets advance only past lines that end in '\n'.
 * - q is monotonic per session across restarts, compactions and adoption: gen files record the highest q issued.
 * - A writer re-checks its own gen file before each append, so a writer that was adopted while idle (or asleep) starts a
 *   fresh generation. A record it wrote into a superseded segment while being adopted (q above the adoption's maxQ) still
 *   counts for every reader and is moved into its live generation when it next starts.
 */
import { MAX_FILE_BYTES, safeRelPath, type StorageEntry, type StoragePort } from './port.ts'
import { utf8Bytes } from './bytes.ts'

export type LogRecord<Op> = { s: string; q: number; t: number; op: Op }

/**
 * Picks the records to keep. It must return records taken from `mine` (same s, q and t; the op may be rewritten, e.g.
 * merged), never new ones: keeping the original stamps is what keeps last-writer-wins and every reader's view correct.
 * `mine` is this session's live records plus any dead writer's it adopts now. `others` is every other session's current
 * records, so a fold can drop records another window has superseded and keep a tombstone only while another window still
 * holds an older put.
 */
export type Fold<Op> = (mine: LogRecord<Op>[], others: LogRecord<Op>[]) => LogRecord<Op>[]

export type SegmentLog<Op> = {
  /** Appends ops as records of this session. An empty list writes nothing. */
  append(ops: Op[]): Promise<void>
  /** Reads every session from disk (one folder listing) and answers the merged records, ordered by (t, s, q). */
  load(): Promise<LogRecord<Op>[]>
  /** Records new since the last load or refresh, from every other session, ordered; [] when nothing changed. */
  refresh(): Promise<LogRecord<Op>[]>
  /** Rewrites this session's records (and any dead writer's) as a new generation with only what `fold` keeps. */
  compactOwn(fold: Fold<Op>): Promise<void>
  /** Marks this session alive in this folder (writes at most once per HEARTBEAT_MS). */
  heartbeat(): Promise<void>
  /** The current merged view, deduped by (s, q) and ordered by (t, s, q). Do not mutate it. */
  all(): readonly LogRecord<Op>[]
  /** Bytes of this session's live segments: the cue for when to compact. */
  ownBytes(): number
  /** Lines that could not be read (unparsable, or a torn fragment at a file's end) plus unreadable gen files, for `/legion doctor`. */
  readonly skipped: number
}

export const DEFAULT_ROLL_BYTES = 1024 * 1024
/** A live session rewrites its alive file at most this often. */
export const HEARTBEAT_MS = 60_000
/** A writer silent this long in a folder is dead there, and any compacting session may adopt its records. */
export const DEAD_AFTER_MS = 24 * 60 * 60 * 1000

const SEG_GEN = /^seg-(.+)-g(\d+)-(\d+)\.jsonl$/
const SEG_ZERO = /^seg-(.+)-(\d+)\.jsonl$/
const GEN_FILE = /^gen-(.+)\.json$/

function isSessionId(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== 'string') return false
  const parts = sessionId.split('-')
  return sessionId.length > 0 && sessionId.length <= 128 && parts.every(p => /^[A-Za-z0-9_]+$/.test(p)) && parts.slice(1).every(p => !/^g\d+$/.test(p))
}

/**
 * Session ids become part of file names, so they are limited to letters, digits, '_' and '-', and no '-'-separated part
 * after the first may look like a generation tag (`g2`): `seg-a-g2-0.jsonl` must have one reading only. Claude Code's
 * session ids (UUIDs, hex) always pass.
 */
export function checkSessionId(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`segment log: unusable session id "${sessionId}" (letters, digits, '_' and '-' only, no "-g<digits>" part)`)
  return sessionId
}

type SegName = { s: string; gen: number; n: number }

export function parseSegName(name: string): SegName | undefined {
  const g = SEG_GEN.exec(name)
  if (g) return { s: g[1]!, gen: Number(g[2]), n: Number(g[3]) }
  const z = SEG_ZERO.exec(name)
  if (z) return { s: z[1]!, gen: 0, n: Number(z[2]) }
  return undefined
}

export function segName(s: string, gen: number, n: number): string {
  return gen === 0 ? `seg-${s}-${n}.jsonl` : `seg-${s}-g${gen}-${n}.jsonl`
}

const genName = (s: string): string => `gen-${s}.json`
const aliveName = (s: string): string => `alive-${s}.json`
export const recordKey = (r: { s: string; q: number }): string => `${r.s}#${r.q}`

type GenInfo = { gen: number; segments: string[]; maxQ: number; maxT: number; adoptedBy?: string; adopterGen?: number; at?: number }

function parseGen(text: string): GenInfo | undefined {
  try {
    const v = JSON.parse(text) as Partial<GenInfo> | null
    if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.gen) || (v.gen as number) < 0) return undefined
    const info: GenInfo = {
      gen: v.gen as number,
      segments: Array.isArray(v.segments) ? v.segments.filter((x): x is string => typeof x === 'string') : [],
      maxQ: Number.isSafeInteger(v.maxQ) ? (v.maxQ as number) : -1,
      maxT: typeof v.maxT === 'number' && Number.isFinite(v.maxT) ? v.maxT : 0,
    }
    if (isSessionId(v.adoptedBy) && Number.isSafeInteger(v.adopterGen)) {
      info.adoptedBy = v.adoptedBy
      info.adopterGen = v.adopterGen as number
      if (typeof v.at === 'number') info.at = v.at
    }
    return info
  } catch {
    return undefined
  }
}

/**
 * One record. In a generation-0 file the record's `s` must be the file's owner; a compacted generation may also hold
 * records it adopted from other sessions, so there any valid session id is accepted.
 */
function parseRecord<Op>(line: string, owner: string, isForeignOk: boolean): LogRecord<Op> | undefined {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const isOwnerOk = r.s === owner || (isForeignOk && isSessionId(r.s))
  if (!isOwnerOk || !Number.isSafeInteger(r.q) || (r.q as number) < 0 || typeof r.t !== 'number' || !Number.isFinite(r.t) || !('op' in r)) return undefined
  return { s: r.s as string, q: r.q as number, t: r.t, op: r.op as Op }
}

type Parsed<Op> = { recs: LogRecord<Op>[]; lines: number; bad: number; hasFragment: boolean; isShrunk: boolean }

/** Parses complete lines from index `from`. A trailing fragment (no '\n' yet) is not consumed. */
function parseLines<Op>(text: string, from: number, owner: string, isForeignOk: boolean): Parsed<Op> {
  const parts = text.split('\n')
  const complete = parts.length - 1
  if (complete < from) return { recs: [], lines: complete, bad: 0, hasFragment: false, isShrunk: true }
  const recs: LogRecord<Op>[] = []
  let bad = 0
  for (let i = from; i < complete; i++) {
    const line = parts[i]!
    if (line.trim() === '') continue
    const rec = parseRecord<Op>(line, owner, isForeignOk)
    if (rec) recs.push(rec)
    else bad++
  }
  return { recs, lines: complete, bad, hasFragment: parts[complete] !== '', isShrunk: false }
}

export function compareRecords(a: LogRecord<unknown>, b: LogRecord<unknown>): number {
  return a.t - b.t || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0) || a.q - b.q
}

/** What a reader knows of one segment file. `isLive`: of the session's current generation. */
type FileMark = { size: number; mtimeMs: number; lines: number; bad: number; hasFragment: boolean; isLive: boolean }

type SessionView<Op> = {
  gen: number
  /** `size:mtime` of the gen file when last read; undefined when there was none. */
  genSig: string | undefined
  genInfo: GenInfo | undefined
  /** True when the gen file could not be parsed and the gen was inferred from the segment names. */
  isGenGuessed: boolean
  files: Map<string, FileMark>
  /** Live records, by recordKey. */
  recs: Map<string, LogRecord<Op>>
  /** Records found in superseded segments past the gen file's maxQ (written while being adopted), and their files. */
  stragglers: LogRecord<Op>[]
  /** Set when a reload gave up (a compaction kept racing it): the next refresh reloads again. */
  isStale: boolean
}

const sigOf = (e: { size: number; mtimeMs: number } | undefined): string | undefined => (e ? `${e.size}:${e.mtimeMs}` : undefined)

type OwnSegment = { name: string; n: number; text: string; bytes: number }
type Line = { line: string; bytes: number }

export function createSegmentLog<Op>(
  port: StoragePort,
  dir: string,
  sessionId: string,
  opts: { rollBytes?: number; now?: () => number } = {},
): SegmentLog<Op> {
  safeRelPath(dir)
  checkSessionId(sessionId)
  const rollBytes = opts.rollBytes ?? DEFAULT_ROLL_BYTES
  if (!Number.isSafeInteger(rollBytes) || rollBytes < 1 || rollBytes > MAX_FILE_BYTES) throw new Error(`segment log: rollBytes must be an integer 1..${MAX_FILE_BYTES}`)
  const now = opts.now ?? (() => Date.now())
  const pathOf = (name: string): string => `${dir}/${name}`

  const views = new Map<string, SessionView<Op>>()
  let isLoaded = false
  let idx: Map<string, LogRecord<Op>> | undefined
  let merged: LogRecord<Op>[] | undefined
  const invalidate = (): void => {
    idx = undefined
    merged = undefined
  }

  // This session's writer state.
  let isOwnReady = false
  let ownGenSig: string | undefined
  let ownSeg: OwnSegment | undefined
  let nextN = 0
  let nextQ = 0
  let lastT = 0
  let ownLiveBytes = 0
  let lastBeat: number | undefined

  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const emptyView = (): SessionView<Op> => ({ gen: 0, genSig: undefined, genInfo: undefined, isGenGuessed: false, files: new Map(), recs: new Map(), stragglers: [], isStale: false })

  /** Every session that has a segment or gen file in the listing. */
  function sessionsIn(entries: StorageEntry[]): Set<string> {
    const out = new Set<string>()
    for (const e of entries) {
      if (e.kind !== 'file') continue
      const seg = parseSegName(e.name)
      if (seg && isSessionId(seg.s)) out.add(seg.s)
      const g = GEN_FILE.exec(e.name)
      if (g && isSessionId(g[1])) out.add(g[1]!)
    }
    return out
  }

  function segsOf(entries: StorageEntry[], s: string): Array<SegName & { entry: StorageEntry }> {
    const out: Array<SegName & { entry: StorageEntry }> = []
    for (const e of entries) {
      if (e.kind !== 'file') continue
      const seg = parseSegName(e.name)
      if (seg && seg.s === s) out.push({ ...seg, entry: e })
    }
    return out.sort((a, b) => a.gen - b.gen || a.n - b.n)
  }

  const fileEntry = (entries: StorageEntry[], name: string): StorageEntry | undefined => entries.find(e => e.kind === 'file' && e.name === name)

  /**
   * Reads one session whole from a listing (the caller's on the first try, a fresh one on a retry): gen file, segments,
   * gen file again. With `texts`, also collects each live file's text (the own writer continues its last segment).
   */
  async function reloadSession(s: string, entries?: StorageEntry[], texts?: Map<string, string>): Promise<void> {
    const before = views.get(s)
    const genPath = pathOf(genName(s))
    for (let attempt = 0; attempt < 4; attempt++) {
      texts?.clear()
      const list = attempt === 0 && entries ? entries : await port.list(dir)
      const sig1 = sigOf(fileEntry(list, genName(s)))
      const genText = sig1 === undefined ? undefined : await port.read(genPath)
      const info = genText === undefined ? undefined : parseGen(genText)
      const segs = segsOf(list, s)
      let gen = 0
      let isGenGuessed = false
      if (info) gen = info.gen
      else if (genText !== undefined) {
        // A torn gen file: the compaction that wrote it had already written its segments, so the highest generation
        // with content is the live one.
        isGenGuessed = true
        for (const seg of segs) if (seg.entry.size > 0) gen = Math.max(gen, seg.gen)
      }
      const view = emptyView()
      view.gen = gen
      view.genSig = sig1
      view.genInfo = info
      view.isGenGuessed = isGenGuessed
      for (const seg of segs) {
        if (seg.gen > gen) continue // a compaction in progress: not live until the gen file names it
        const isLive = seg.gen === gen
        if (!isLive && (!info || seg.entry.size === 0)) continue
        const text = await port.read(pathOf(seg.entry.name))
        if (text === undefined) continue
        const p = parseLines<Op>(text, 0, s, seg.gen > 0)
        if (isLive) for (const r of p.recs) view.recs.set(recordKey(r), r)
        else
          for (const r of p.recs)
            if (r.s === s && r.q > info!.maxQ) {
              view.recs.set(recordKey(r), r)
              view.stragglers.push(r)
            }
        view.files.set(seg.entry.name, { size: utf8Bytes(text), mtimeMs: seg.entry.mtimeMs, lines: p.lines, bad: isLive ? p.bad : 0, hasFragment: isLive && p.hasFragment, isLive })
        if (isLive) texts?.set(seg.entry.name, text)
      }
      const sig2 = sigOf(await port.stat(genPath))
      if (sig2 !== sig1) continue
      // Within one generation files only grow (only a gen flip removes records, and gens only go up). A reload in the
      // same gen may have caught a file mid-rewrite (write may truncate first), so it keeps what was already read.
      if (before && before.gen === view.gen) for (const [k, r] of before.recs) if (!view.recs.has(k)) view.recs.set(k, r)
      views.set(s, view)
      invalidate()
      return
    }
    // A compaction kept racing the reload: keep the last good view and try again on the next refresh.
    if (before) before.isStale = true
    else views.set(s, { ...emptyView(), isStale: true })
  }

  /** Reads only what changed in another session since the last look. Answers whether its records may have changed. */
  async function refreshSession(s: string, entries: StorageEntry[]): Promise<boolean> {
    const view = views.get(s)
    const reload = async (): Promise<boolean> => {
      await reloadSession(s, entries)
      return true
    }
    if (!view || view.isStale) return reload()
    if (sigOf(fileEntry(entries, genName(s))) !== view.genSig) return reload()
    const segs = segsOf(entries, s)
    const listed = new Set(segs.map(x => x.entry.name))
    for (const [name, mark] of view.files) if (mark.isLive && !listed.has(name)) return reload()
    let isChanged = false
    for (const seg of segs) {
      if (seg.gen > view.gen) continue
      const name = seg.entry.name
      const mark = view.files.get(name)
      const isSame = mark !== undefined && mark.size === seg.entry.size && mark.mtimeMs === seg.entry.mtimeMs
      if (seg.gen < view.gen) {
        // A superseded file: normally blank. One that gains or loses content (a straggler, or blanking) is re-read whole.
        if (view.isGenGuessed || !view.genInfo || isSame || (mark === undefined && seg.entry.size === 0)) continue
        return reload()
      }
      if (isSame) continue
      if (mark && seg.entry.size < mark.size) return reload()
      const text = await port.read(pathOf(name))
      if (text === undefined) return reload()
      const p = parseLines<Op>(text, mark?.lines ?? 0, s, seg.gen > 0)
      if (p.isShrunk) return reload()
      for (const r of p.recs) {
        const k = recordKey(r)
        if (view.recs.has(k)) continue
        view.recs.set(k, r)
        isChanged = true
      }
      view.files.set(name, { size: utf8Bytes(text), mtimeMs: seg.entry.mtimeMs, lines: p.lines, bad: (mark?.bad ?? 0) + p.bad, hasFragment: p.hasFragment, isLive: true })
    }
    if (isChanged) invalidate()
    return isChanged
  }

  /** Reloads any adopter this reader's view has not caught up with, so adopted records never blink out. */
  async function settleAdoptions(): Promise<boolean> {
    let isChanged = false
    for (const [s, v] of [...views]) {
      const by = v.genInfo?.adoptedBy
      const g = v.genInfo?.adopterGen
      if (by === undefined || g === undefined || by === s || by === sessionId) continue
      if ((views.get(by)?.gen ?? -1) >= g) continue
      await reloadSession(by)
      isChanged = true
    }
    return isChanged
  }

  function toLines(recs: LogRecord<Op>[]): Line[] {
    return recs.map(r => {
      const line = `${JSON.stringify(r)}\n`
      const bytes = utf8Bytes(line)
      if (bytes > MAX_FILE_BYTES) throw new Error(`segment log: one record is ${bytes} bytes, over the ${MAX_FILE_BYTES}-byte file limit`)
      return { line, bytes }
    })
  }

  /** Writes lines after the own current segment, rolling as needed. Only segments that gain lines are written. */
  async function writeOwnLines(lines: Line[]): Promise<void> {
    const gen = ownView().gen
    const writes: OwnSegment[] = []
    let cur: OwnSegment = ownSeg ? { ...ownSeg } : { name: segName(sessionId, gen, nextN), n: nextN, text: '', bytes: 0 }
    let isCurChanged = false
    for (const { line, bytes } of lines) {
      if (cur.bytes > 0 && cur.bytes + bytes > rollBytes) {
        if (isCurChanged) writes.push(cur)
        cur = { name: segName(sessionId, gen, cur.n + 1), n: cur.n + 1, text: '', bytes: 0 }
      }
      cur.text += line
      cur.bytes += bytes
      isCurChanged = true
    }
    writes.push(cur)
    for (const w of writes) {
      try {
        await port.write(pathOf(w.name), w.text)
      } catch (err) {
        // What reached disk is unknown: never rewrite that file again, continue in a fresh one.
        ownSeg = undefined
        nextN = cur.n + 1
        throw err
      }
    }
    ownSeg = cur
    nextN = cur.n
    ownLiveBytes += lines.reduce((sum, l) => sum + l.bytes, 0)
  }

  /** Loads this session's own files and sets the writer up to continue after them. */
  async function initOwn(entries?: StorageEntry[]): Promise<void> {
    const texts = new Map<string, string>()
    await reloadSession(sessionId, entries, texts)
    const view = views.get(sessionId)!
    // Only this session writes its gen file (or an adopter, once), so a reload that keeps racing means a second writer
    // with the same id. Writing on would reuse q values, so stop instead.
    if (view.isStale) throw new Error(`segment log: ${dir} for session ${sessionId} keeps changing under its own writer; is the same session open twice?`)
    let maxQ = view.genInfo?.maxQ ?? -1
    let maxT = view.genInfo?.maxT ?? 0
    for (const r of view.recs.values()) {
      if (r.s === sessionId && r.q > maxQ) maxQ = r.q
      if (r.t > maxT) maxT = r.t
    }
    nextQ = maxQ + 1
    lastT = maxT
    ownGenSig = view.genSig
    ownLiveBytes = 0
    let last: { name: string; n: number } | undefined
    for (const [name, mark] of view.files) {
      if (!mark.isLive) continue
      ownLiveBytes += mark.size
      const seg = parseSegName(name)!
      if (!last || seg.n > last.n) last = { name, n: seg.n }
    }
    nextN = last ? last.n + 1 : 0
    ownSeg = undefined
    if (last) {
      const text = texts.get(last.name) ?? ''
      const bytes = utf8Bytes(text)
      // Continue the last segment only when it ends cleanly and has room; a torn tail is left as it is.
      if ((text === '' || text.endsWith('\n')) && bytes < rollBytes) {
        ownSeg = { name: last.name, n: last.n, text, bytes }
        nextN = last.n
      }
    }
    isOwnReady = true
    // Records written into a superseded segment while this session was being adopted move into the live generation.
    if (view.stragglers.length > 0) {
      await writeOwnLines(toLines([...view.stragglers].sort((a, b) => a.q - b.q)))
      view.stragglers = []
    }
    // Finish a compaction or adoption that stopped before blanking: superseded own segments are emptied (skipped while
    // the gen is a guess).
    if (!view.isGenGuessed) {
      for (const seg of segsOf(entries ?? (await port.list(dir)), sessionId)) if (seg.gen < view.gen && seg.entry.size > 0) await port.write(pathOf(seg.entry.name), '')
    }
    await settleAdoptions()
  }

  async function beat(at: number): Promise<void> {
    if (lastBeat !== undefined && at - lastBeat < HEARTBEAT_MS) return
    lastBeat = at
    await port.write(pathOf(aliveName(sessionId)), JSON.stringify({ at }))
  }

  async function loadAll(): Promise<LogRecord<Op>[]> {
    views.clear()
    invalidate()
    const entries = await port.list(dir)
    const sessions = sessionsIn(entries)
    sessions.delete(sessionId)
    await initOwn(entries)
    for (const s of sessions) await reloadSession(s, entries)
    await settleAdoptions()
    isLoaded = true
    return [...all()]
  }

  async function refreshInner(): Promise<LogRecord<Op>[]> {
    if (!isLoaded) return loadAll()
    const entries = await port.list(dir)
    const before = index()
    let isChanged = false
    // An adopter may have flipped this session's gen file while it was idle.
    if (sigOf(fileEntry(entries, genName(sessionId))) !== ownGenSig) {
      await initOwn(entries)
      isChanged = true
    }
    for (const s of sessionsIn(entries)) {
      if (s === sessionId) continue // only this session writes its live files; its records are already in the view
      if (await refreshSession(s, entries)) isChanged = true
    }
    if (await settleAdoptions()) isChanged = true
    await beat(now())
    if (!isChanged) return []
    const fresh: LogRecord<Op>[] = []
    for (const [k, r] of index()) if (!before.has(k)) fresh.push(r)
    return fresh.sort(compareRecords)
  }

  function index(): Map<string, LogRecord<Op>> {
    if (!idx) {
      idx = new Map()
      for (const v of views.values()) for (const [k, r] of v.recs) if (!idx.has(k)) idx.set(k, r)
    }
    return idx
  }

  function all(): readonly LogRecord<Op>[] {
    if (!merged) merged = [...index().values()].sort(compareRecords)
    return merged
  }

  function ownView(): SessionView<Op> {
    let v = views.get(sessionId)
    if (!v) views.set(sessionId, (v = emptyView()))
    return v
  }

  async function appendInner(ops: Op[]): Promise<void> {
    if (!isOwnReady) await initOwn()
    else if (sigOf(await port.stat(pathOf(genName(sessionId)))) !== ownGenSig) await initOwn() // adopted while idle
    if (ops.length === 0) return
    const t = Math.max(now(), lastT)
    const recs = ops.map((op, i): LogRecord<Op> => ({ s: sessionId, q: nextQ + i, t, op }))
    const lines = toLines(recs)
    // q values are spent even if a write fails below, so a q a reader may have seen is never reused.
    nextQ += recs.length
    lastT = t
    await writeOwnLines(lines)
    const view = ownView()
    for (const r of recs) view.recs.set(recordKey(r), r)
    invalidate()
    await beat(t)
  }

  /** Dead in this folder: alive file over DEAD_AFTER_MS old, or none and every file of the session that old. */
  async function isDead(s: string, entries: StorageEntry[], at: number): Promise<boolean> {
    const alive = fileEntry(entries, aliveName(s))
    if (alive) {
      const text = await port.read(pathOf(aliveName(s)))
      let beatAt: unknown
      try {
        beatAt = text === undefined ? undefined : (JSON.parse(text) as { at?: unknown }).at
      } catch {
        beatAt = undefined
      }
      if (typeof beatAt === 'number' && Number.isFinite(beatAt)) return at - beatAt > DEAD_AFTER_MS
    }
    let newest = 0
    for (const seg of segsOf(entries, s)) newest = Math.max(newest, seg.entry.mtimeMs)
    newest = Math.max(newest, fileEntry(entries, genName(s))?.mtimeMs ?? 0)
    return newest > 0 && at - newest > DEAD_AFTER_MS
  }

  async function compactInner(fold: Fold<Op>): Promise<void> {
    if (!isOwnReady) await initOwn()
    await refreshInner()
    const at = now()
    const entries = await port.list(dir)
    const own = ownView()

    const dead: string[] = []
    for (const [s, v] of views) {
      if (s === sessionId || v.recs.size === 0 || v.isStale || v.isGenGuessed) continue
      if (await isDead(s, entries, at)) dead.push(s)
    }
    const mineMap = new Map(own.recs)
    for (const s of dead) for (const [k, r] of views.get(s)!.recs) if (!mineMap.has(k)) mineMap.set(k, r)
    const mine = [...mineMap.values()].sort(compareRecords)
    const others = [...index().entries()].filter(([k]) => !mineMap.has(k)).map(([, r]) => r)
    const kept = fold(mine, others)
    const seen = new Set<string>()
    for (const r of kept) {
      const k = recordKey(r)
      const orig = mineMap.get(k)
      if (!orig || orig.s !== r.s || orig.t !== r.t || seen.has(k)) throw new Error('segment log: a fold must return records taken from its own input, each once, with their s, q and t unchanged')
      seen.add(k)
    }
    // A record another live holder with a smaller session id also keeps (two windows adopted one writer) is left to it.
    const holders = [...views].filter(([s]) => s !== sessionId && s < sessionId && !dead.includes(s)).map(([, v]) => v)
    const keep = kept.filter(r => !holders.some(v => v.recs.has(recordKey(r)))).sort(compareRecords)

    let newGen = own.gen
    for (const seg of segsOf(entries, sessionId)) newGen = Math.max(newGen, seg.gen)
    newGen += 1

    const lines = toLines(keep)
    const segs: OwnSegment[] = []
    let cur: OwnSegment | undefined
    for (const { line, bytes } of lines) {
      if (!cur || (cur.bytes > 0 && cur.bytes + bytes > rollBytes)) {
        cur = { name: segName(sessionId, newGen, segs.length), n: segs.length, text: '', bytes: 0 }
        segs.push(cur)
      }
      cur.text += line
      cur.bytes += bytes
    }
    for (const seg of segs) await port.write(pathOf(seg.name), seg.text)
    const info: GenInfo = { gen: newGen, segments: segs.map(x => x.name), maxQ: nextQ - 1, maxT: Math.max(lastT, ...keep.map(r => r.t)) }
    await port.write(pathOf(genName(sessionId)), JSON.stringify(info))
    ownGenSig = sigOf(await port.stat(pathOf(genName(sessionId))))

    // The flip is done: from here the new generation is the live one, even if blanking below fails.
    const nextView = emptyView()
    nextView.gen = newGen
    nextView.genInfo = info
    nextView.genSig = ownGenSig
    for (const r of keep) nextView.recs.set(recordKey(r), r)
    for (const seg of segs) nextView.files.set(seg.name, { size: seg.bytes, mtimeMs: 0, lines: seg.text.split('\n').length - 1, bad: 0, hasFragment: false, isLive: true })
    views.set(sessionId, nextView)
    invalidate()
    lastT = info.maxT
    const last = segs[segs.length - 1]
    ownSeg = last && last.bytes < rollBytes ? { ...last } : undefined
    nextN = last ? (ownSeg ? last.n : last.n + 1) : 0
    ownLiveBytes = segs.reduce((sum, x) => sum + x.bytes, 0)

    // Each adopted writer: flip its gen file to an empty generation that names this one, then blank its segments.
    for (const d of dead) {
      const dv = views.get(d)!
      if (sigOf(await port.stat(pathOf(genName(d)))) !== dv.genSig) continue // it moved on: copies collapse on read
      let dMaxQ = dv.genInfo?.maxQ ?? -1
      for (const r of dv.recs.values()) if (r.s === d && r.q > dMaxQ) dMaxQ = r.q
      const dInfo: GenInfo = { gen: dv.gen + 1, segments: [], maxQ: dMaxQ, maxT: dv.genInfo?.maxT ?? 0, adoptedBy: sessionId, adopterGen: newGen, at }
      for (const r of dv.recs.values()) if (r.t > dInfo.maxT) dInfo.maxT = r.t
      await port.write(pathOf(genName(d)), JSON.stringify(dInfo))
      const dView = emptyView()
      dView.gen = dInfo.gen
      dView.genInfo = dInfo
      dView.genSig = sigOf(await port.stat(pathOf(genName(d))))
      views.set(d, dView)
      invalidate()
      for (const seg of segsOf(await port.list(dir), d)) {
        if (seg.gen > dv.gen || seg.entry.size === 0) continue
        // Leave a file that gained a record past maxQ since it was read (its writer woke up): readers still count it.
        const text = (await port.read(pathOf(seg.entry.name))) ?? ''
        if (parseLines<Op>(text, 0, d, seg.gen > 0).recs.some(r => r.s === d && r.q > dMaxQ)) continue
        await port.write(pathOf(seg.entry.name), '')
      }
    }

    for (const seg of segsOf(await port.list(dir), sessionId)) if (seg.gen !== newGen && seg.entry.size > 0) await port.write(pathOf(seg.entry.name), '')
    await beat(at)
  }

  return {
    append: ops => serial(() => appendInner(ops)),
    load: () => serial(loadAll),
    refresh: () => serial(refreshInner),
    compactOwn: fold => serial(() => compactInner(fold)),
    heartbeat: () => serial(() => beat(now())),
    all,
    ownBytes: () => ownLiveBytes,
    get skipped() {
      let n = 0
      for (const v of views.values()) {
        if (v.isGenGuessed) n++ // an unreadable gen file
        for (const f of v.files.values()) n += f.bad + (f.hasFragment ? 1 : 0)
      }
      return n
    },
  }
}
