/**
 * The development trace: every decision the runtime makes, one JSON line each, so "did Zealot delegate, to whom, what was
 * refused and why" is one command away (`node scripts/mod-trace.mjs`), not an archaeology session.
 *
 * Off by default: `LEGION_MOD_TRACE=1` in the environment, or `/legion trace on` for the session. Off costs one boolean check per
 * call site and writes nothing. On, lines are kept in memory (the last MAX_LINES) and the session's own file is rewritten at most
 * once a second (`$.fs` has no append). The file is the session's alone, under `<data root>/debug/`, never shared.
 *
 * What it holds: ids, agent ids, tool names, counts, reasons, and text cut to TEXT_MAX characters. Nothing secret passes through
 * the runtime, but prompts and answers are the person's words: cut, local, and off unless asked for.
 */
export const MAX_LINES = 4000
export const TEXT_MAX = 160
export const FLUSH_MS = 1000

export type TraceKind =
  | 'boot' | 'cmd' | 'queue' | 'result' | 'adopt' | 'step' | 'tool' | 'deny' | 'toolDone' | 'reply' | 'finish'
  | 'mood' | 'drop' | 'channel' | 'stage' | 'error'

export type TraceLine = { t: number; k: TraceKind; task?: string; agent?: string; run?: string } & Record<string, unknown>

export type Trace = {
  isOn: boolean
  lines: TraceLine[]
  /** True when lines were added since the last flush. */
  isDirty: boolean
}

export const newTrace = (isOn: boolean): Trace => ({ isOn, lines: [], isDirty: false })

/** Cuts a value for the trace: strings to TEXT_MAX with an ellipsis; anything else as it is. */
export function cut(v: unknown, max = TEXT_MAX): unknown {
  if (typeof v !== 'string') return v
  const one = v.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Adds one line when tracing is on. Returns whether it did. */
export function record(trace: Trace, line: TraceLine): boolean {
  if (!trace.isOn) return false
  const clean: TraceLine = { t: line.t, k: line.k }
  for (const [key, value] of Object.entries(line)) if (key !== 't' && key !== 'k' && value !== undefined) clean[key] = cut(value)
  trace.lines.push(clean)
  if (trace.lines.length > MAX_LINES) trace.lines.splice(0, trace.lines.length - MAX_LINES)
  trace.isDirty = true
  return true
}

/** The file text for the current lines. */
export const traceText = (trace: Trace): string => trace.lines.map(l => JSON.stringify(l)).join('\n') + (trace.lines.length ? '\n' : '')

/** The session's trace file, relative to the data root's folder. */
export const traceFile = (sessionId: string): string => `debug/trace-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`
