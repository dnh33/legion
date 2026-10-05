/**
 * Legion mod: the wiring. Events in, services and views out. Each area lives in its own module under src/; this file only
 * connects them, so it stays short enough to read in one sitting.
 */
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'legion', description: 'Open Legion: your order of agents, their threads and the shared Library' })
    return next(e)
  })

  on('command.run', { command: 'legion' }, async $ => {
    await $.ui.open({ id: 'legion', title: 'Legion' })
    return { text: 'Legion opened.' }
  })
}
