/**
 * Development preview: renders the UI's rows at 40-200 cells to a text dump, one HTML page per theme, and one HTML page per
 * key scene (`<slug>-dark.html`, `<slug>-light.html`) for the A-gate pictures. The HTML is a true cell grid: every
 * character sits in a box exactly as wide as the cells the UI counts for it (src/ui/text.ts cellWidth), so a glyph a
 * browser font draws wider or narrower cannot bend a column. That is what a terminal does; a preview that bends where a
 * terminal would not is a preview that lies.
 *
 * Usage (from the repo root): node --experimental-transform-types --no-warnings mod/dev/preview.ts <outDir> [widths]
 * `widths` is comma separated (default 40,56,60,64,68,72,80,100,120,200). LEGION_MOD_ROOT (a file:// URL ending in /)
 * draws another copy of the mod, for a "before" set. Not part of the plugin: nothing under hooks/ imports it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
const R = process.env.LEGION_MOD_ROOT ?? new URL('../', import.meta.url).href
const { paneLayout } = await import(R + 'src/ui/views/pane.ts')
const { bandRows } = await import(R + 'src/ui/band.ts')
const { dispatchRows } = await import(R + 'src/ui/dispatch.ts')
const { statusText } = await import(R + 'src/ui/status.ts')
const { wrapCells, padCells, cellWidth } = await import(R + 'src/ui/text.ts')
const { palette } = await import(R + 'src/theme.ts')
// the fixtures always come from this tree, so a "before" set draws the same data
const F = await import(new URL('../test/node/ui/fixtures.ts', import.meta.url).href)

type Cell = { text: string; tone?: string; bold?: boolean; strike?: boolean; button?: boolean; hotkey?: string; dim?: boolean }
const out = process.argv[2] as string
mkdirSync(out, { recursive: true })

const partsOf = (p: any): Cell[] => p.t === 'button'
  ? (p.hotkey ? [{ text: p.hotkey, tone: 'accent', button: true }, { text: `: ${p.label}`, button: true, dim: p.dim }] : [{ text: p.label, button: true, dim: p.dim }])
  : [{ text: p.text, tone: p.tone, bold: p.bold, strike: p.strike }]

/** One row to lines of cells; md rows are wrapped as plain text beside their lead. */
const rowLines = (r: any, width: number): Cell[][] => {
  if (r.t === 'gap') return [[{ text: '' }]]
  if (r.t === 'line') return [r.parts.flatMap(partsOf)]
  const lines = wrapCells(r.text, Math.max(1, (r.width ?? width) - r.leadWidth))
  return lines.map((l: string, i: number) => [...(i === 0 ? r.lead.flatMap(partsOf) : [{ text: ' '.repeat(r.leadWidth) }]), { text: l, dim: r.dim }])
}

const paneLines = (s: any, w: number, rows = 40): Cell[][] => {
  const l = paneLayout(s, w, rows)
  const title = l.title.flatMap((r: any) => rowLines(r, w))
  const main = l.main.flatMap((r: any) => rowLines(r, w - l.railWidth))
  if (!l.railWidth) return [...title, ...main]
  const rail = l.rail.flatMap((r: any) => rowLines(r, l.railWidth))
  const n = Math.max(rail.length, main.length)
  const lines: Cell[][] = [...title]
  for (let i = 0; i < n; i++) lines.push([...(rail[i] ?? [{ text: ' '.repeat(l.railWidth - 1) }, { text: '│', tone: 'line' }]), ...(main[i] ?? [])])
  return lines
}
const rowsLines = (rows: any[], w: number): Cell[][] => rows.flatMap(r => rowLines(r, w))

const SCENES: Array<[string, (w: number) => Cell[][]]> = []
const chat = (name: string, s: () => any) => SCENES.push([`chat · ${name}`, w => paneLines(s(), w)])
const view = (s: any, v: string, extra: any = {}) => ({ ...s, ui: { ...s.ui, view: v, ...extra } })
chat('first open', () => F.base({ ui: { view: 'chat', agentId: 'zealot', taskId: null, channel: null } }))
chat('watching a request (Zealot tree)', () => F.fleetLive())
SCENES.push(['order · watching a request', w => paneLines(view(F.fleetLive(), 'order'), w)])
chat('needs your OK', () => F.busy({ live: '' }))
chat('needs your OK, steps open', () => F.busy({ live: '', ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000001', channel: null, stepsOpen: 't_000000000001' } }))
chat('paused', () => F.fleet({ ui: { view: 'chat', agentId: 'herald', taskId: 't_0000000000b1', channel: null }, thread: [], moods: {} }))
chat('done, back later', () => F.fleet({ ui: { view: 'chat', agentId: 'archivist', taskId: 't_0000000000b0', channel: null }, thread: [], moods: {} }))
chat('failed', () => F.busy({ ui: { view: 'chat', agentId: 'scout', taskId: 't_000000000003', channel: null }, thread: [], live: '' }))
chat('other window', () => F.busy({ sessionId: 'me', live: '' }))
chat('agent with no task', () => F.base({ tasks: [F.task('t_000000000077', 'scout', 'done')] }))
chat('no agents', () => F.base({ agents: [] }))
chat('long (300-char title, 99+ OKs, ≈$1,234.56)', () => F.long())
SCENES.push(['keys (k)', w => paneLines(view(F.busy(), 'chat', { keysOpen: true }), w)])
SCENES.push(['order · busy + doctor', w => paneLines({ ...view(F.busy(), 'order'), doctor: F.DOCTOR }, w)])
SCENES.push(['order · long', w => paneLines(view(F.long(), 'order'), w)])
SCENES.push(['order · empty', w => paneLines(view(F.base(), 'order'), w)])
SCENES.push(['band · needs your OK + paused (wire text)', w => rowsLines(bandRows(F.busy({ band: [F.wireBand('paused', 't_000000000002', 'builder', 'tests')] }), w, 10), w)])
SCENES.push(['band · done + failed (wire text)', w => rowsLines(bandRows(F.busy({ cards: [], band: [F.wireBand('done', 't_000000000004', 'scribe', 'docs', 2), F.wireBand('error', 't_000000000003', 'scout', 'find the leak', 1)] }), w, 10), w)])
SCENES.push(['band · long', w => rowsLines(bandRows(F.long(), w, 10), w)])
SCENES.push(['band · channel open', w => rowsLines(bandRows(F.base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } }), w, 10), w)])
const sent = (id: string) => F.sentTo('⌘ Builder', id)
SCENES.push(['dispatch · working, needs your OK', w => rowsLines(dispatchRows(F.busy(), sent('t_000000000001'), w) ?? [], w)])
SCENES.push(['dispatch · done', w => rowsLines(dispatchRows(F.busy(), sent('t_000000000004'), w) ?? [], w)])
SCENES.push(['dispatch · paused', w => rowsLines(dispatchRows(F.busy(), sent('t_000000000002'), w) ?? [], w)])
SCENES.push(['dispatch · failed', w => rowsLines(dispatchRows(F.busy(), sent('t_000000000003'), w) ?? [], w)])
SCENES.push(['status line', () => [F.base(), F.busy(), F.long(), F.fleetLive(), F.base({ ui: { view: 'chat', agentId: 'builder', taskId: null, channel: 'zealot' } })].map(s => [{ text: statusText(s) ?? '(cleared)' }])])

const WIDTHS = (process.argv[3] ?? '40,56,60,64,68,72,80,100,120,200').split(',').map(Number)
/** The scenes the review looks at as pictures, at the widths a person meets them. */
const PICTURES: Record<string, { scene: string; widths: number[] }> = {
  'first-open': { scene: 'chat · first open', widths: [60, 80, 120] },
  'watching-a-request': { scene: 'chat · watching a request (Zealot tree)', widths: [60, 80, 120] },
  'order-watching': { scene: 'order · watching a request', widths: [60, 100] },
  'needs-your-ok': { scene: 'chat · needs your OK', widths: [60, 80, 120] },
  'paused': { scene: 'chat · paused', widths: [60, 80] },
  'band': { scene: 'band · needs your OK + paused (wire text)', widths: [60, 80] },
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const txt: string[] = []
const html: Record<'dark' | 'light', string[]> = { dark: [], light: [] }
const pictures: Record<string, Record<'dark' | 'light', string[]>> = {}
const page = (t: 'dark' | 'light', title: string, body: string): string => {
  const pal = palette(t)
  return `<!doctype html><meta charset=utf-8><title>${esc(title)}</title><style>body{background:${pal.bg};color:${pal.text};font:13px/1.25 'Cascadia Mono',Consolas,monospace;padding:12px;margin:0}h3{font:600 12px system-ui;color:${pal.muted};margin:14px 0 4px}pre{margin:0;padding:4px 0;border:1px solid ${pal.line};background:${pal.bg};font:inherit;white-space:pre}pre i{display:inline-block;font-style:normal;text-align:center;overflow:visible}</style>${body}`
}
for (const [name, make] of SCENES) {
  for (const w of name === 'status line' ? [80] : WIDTHS) {
    let lines: Cell[][]
    try { lines = make(w) } catch (err) { lines = [[{ text: `(this tree cannot draw it: ${(err as Error).message})` }]] }
    txt.push(`=== ${name} @${w}`, '+' + '-'.repeat(w) + '+')
    for (const l of lines) txt.push('|' + padCells(l.map(c => c.text).join(''), w) + '|')
    txt.push('+' + '-'.repeat(w) + '+', '')
    for (const t of ['dark', 'light'] as const) {
      const pal = palette(t)
      const color = (c: Cell) => c.tone === 'accent' ? pal.accentText : c.tone === 'warn' ? pal.warn : c.tone === 'danger' ? pal.danger : c.tone === 'line' ? pal.lineStrong : pal.text
      // One box per character, as wide as its cells: the grid a terminal keeps. Buttons draw as their text, as a terminal does.
      const cells = (t: string) => [...t].map(ch => `<i style="width:${Math.max(1, cellWidth(ch))}ch">${esc(ch)}</i>`).join('')
      const body = lines.map(l => l.map(c => `<span style="color:${color(c)};${c.bold ? 'font-weight:700;' : ''}${c.tone === 'muted' || c.dim ? 'opacity:.55;' : ''}${c.strike ? 'text-decoration:line-through;' : ''}">${cells(c.text)}</span>`).join('')).join('\n')
      const block = `<h3>${esc(name)} @${w}</h3><pre style="width:${w}ch">${body}</pre>`
      html[t].push(block)
      for (const [slug, pic] of Object.entries(PICTURES)) if (pic.scene === name && pic.widths.includes(w)) ((pictures[slug] ??= { dark: [], light: [] })[t]).push(block)
    }
  }
}
writeFileSync(`${out}/dumps.txt`, txt.join('\n'))
for (const t of ['dark', 'light'] as const) writeFileSync(`${out}/${t}.html`, page(t, `Legion TUI ${t}`, html[t].join('\n')))
for (const [slug, p] of Object.entries(pictures)) for (const t of ['dark', 'light'] as const) writeFileSync(`${out}/${slug}-${t}.html`, page(t, slug, p[t].join('\n')))
console.log('wrote', SCENES.length, 'scenes,', Object.keys(pictures).length, 'pictures')
