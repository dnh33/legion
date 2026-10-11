/**
 * Progress emission — one wire shape for every update stage.
 *
 * The update panel consumes these events; without them the panel shows a
 * spinner and nothing else. Every stage names itself so the panel can show
 * "Downloading", "Verifying", "Restarting" instead of a generic percentage.
 */

export type UpdateStage =
  | 'preflight'
  | 'download'
  | 'verify'
  | 'teardown'
  | 'swap'
  | 'health'
  | 'relaunch'
  | 'error'

export interface ProgressEvent {
  stage: UpdateStage
  message: string
  /** 0..100, or null when the stage has no measurable percentage. */
  percent: number | null
}

export type ProgressSink = (event: ProgressEvent) => void

/** A no-op sink for tests and headless contexts. */
export const silentProgress: ProgressSink = () => {}

/**
 * Collect progress events for assertions in tests. Returns the sink and the
 * recorded events array (same reference — inspect it after the operation).
 */
export function collectProgress(): { sink: ProgressSink; events: ProgressEvent[] } {
  const events: ProgressEvent[] = []
  return { sink: (e) => void events.push(e), events }
}

/**
 * Wrap a sink so a stage transition is logged. Useful when the real sink is a
 * UI channel that swallows errors — the log survives.
 */
export function loggingProgress(log: (msg: string) => void, sink: ProgressSink = silentProgress): ProgressSink {
  return (event) => {
    log(`[updater] ${event.stage}: ${event.message}${event.percent !== null ? ` (${event.percent}%)` : ''}`)
    sink(event)
  }
}
