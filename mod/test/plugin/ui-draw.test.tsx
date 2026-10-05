/**
 * The Legion UI's drawings on each surface's element table, before register.tsx wires registerUi.
 *
 * A test's own `ui.render` hook (beneath the plugin) draws through the same pure components the plugin's hooks use,
 * from fixture snapshots, so this proves: every tree validates on the terminal and desktop tables at every width and
 * state, the controls are there with their action keys (actions.ts) and hotkeys, a press goes through, and dark and
 * light draw in their own colours. What a press does is the lead's `ui.press` hook, tested there. A test module may not read `$.state` (the host refuses it), so the state path is covered by
 * ui-wired.test.tsx once the wiring lands.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { RenderSurface } from 'claude-code'
import { palette } from '../../src/theme.ts'
import { Pane, Rows } from '../../src/ui/components.tsx'
import { bandRows } from '../../src/ui/band.ts'
import { dispatchRows } from '../../src/ui/dispatch.ts'
import { paneLayout } from '../../src/ui/views/pane.ts'
import type { Snapshot } from '../../src/ui/views/common.ts'
import { base, busy, card, long, WIDTHS } from '../node/ui/fixtures.ts'

/**
 * A pane id of the test's own, so the plugin's pane hook (matched on 'legion') never answers it, wired or not. The band
 * and the transcript row pass through the plugin to these hooks: with no state fed, it has nothing to draw there.
 */
const DRAW = 'legion-draw'
const SURFACES = ['terminal', 'desktop'] as const satisfies readonly RenderSurface[]
const paneProps = (bodyColumns: number) => ({ title: 'Legion', isFocused: true, bodyColumns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} })
const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} })

const STATES: Record<string, () => Snapshot> = {
  empty: () => base(),
  'no agents': () => base({ agents: [] }),
  busy: () => busy(),
  long: () => long(),
  error: () => busy({ ui: { view: 'chat', agentId: 'scout', taskId: 't_000000000003', channel: null }, thread: [], live: '' }),
  paused: () => busy({ ui: { view: 'chat', agentId: 'builder', taskId: 't_000000000002', channel: null }, live: '' }),
  order: () => busy({ ui: { view: 'order', agentId: 'builder', taskId: null, channel: null } }),
}

for (const [name, make] of Object.entries(STATES)) {
  test(`pane (${name}): draws on terminal and desktop at every width, light and dark`, async ($, on) => {
    mock.clock(on)
    let theme: 'dark' | 'light' = 'dark'
    on('ui.render', { component: 'Pane', requestId: DRAW }, async ($, e) =>
      Pane($.ui.resolve(e), palette(theme), paneLayout(make(), e.props.bodyColumns, e.props.scroll.bodyRows)))
    for (const t of ['dark', 'light'] as const) {
      for (const surface of SURFACES) {
        for (const w of WIDTHS) {
          theme = t
          const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: DRAW, props: paneProps(w) })
          expect(await ui.find({ type: 'Text', text: '✠ LEGION' }), `${t}/${surface}/${w}`).toBeDefined()
          await ui.unmount()
        }
      }
    }
  })
}

test('pane: the keys are drawn with their hotkeys, and each press goes through', async ($, on) => {
  mock.clock(on)
  on('ui.render', { component: 'Pane', requestId: DRAW }, async ($, e) =>
    Pane($.ui.resolve(e), palette('dark'), paneLayout(busy(), e.props.bodyColumns, e.props.scroll.bodyRows)))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: DRAW, props: paneProps(120) })
    const buttons = await ui.findAll({ type: 'Button' })
    const hotkeys = buttons.flatMap(b => (typeof b.props.hotkey === 'string' ? [b.props.hotkey] : [])).sort()
    expect(hotkeys).toEqual(['5', 'a', 'd', 'n', 's'])
    for (const key of ['view:order', 'new:builder', 'allow:c1', 'deny:c1', 'stop:t_000000000001', 'agent:scout', 'task:t_000000000002']) {
      expect(await ui.find({ type: 'Button', key }), key).toBeDefined()
      await ui.press({ key, plugin: 'test' })
    }
    await ui.unmount()
  }
})

test('pane: a click-only card draws Allow with no hotkey', async ($, on) => {
  mock.clock(on)
  const snap = busy({ cards: [card('c1', 't_000000000001', 'builder', { isClickOnly: true })] })
  on('ui.render', { component: 'Pane', requestId: DRAW }, async ($, e) =>
    Pane($.ui.resolve(e), palette('dark'), paneLayout(snap, e.props.bodyColumns, 40)))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: DRAW, props: paneProps(100) })
    const allow = await ui.find({ type: 'Button', key: 'allow:c1' })
    expect(allow?.props.hotkey).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'deny:c1' }))?.props.hotkey).toBe('d')
    await ui.unmount()
  }
})

test('theme: the wordmark draws in each palette\'s own accent', async ($, on) => {
  mock.clock(on)
  let theme: 'dark' | 'light' = 'dark'
  on('ui.render', { component: 'Pane', requestId: DRAW }, async ($, e) =>
    Pane($.ui.resolve(e), palette(theme), paneLayout(busy(), e.props.bodyColumns, 40)))
  const colour = async (t: 'dark' | 'light'): Promise<unknown> => {
    theme = t
    const ui = await $.ui.mount({ plugin: 'legion-mod', surface: 'terminal', component: 'Pane', requestId: DRAW, props: paneProps(100) })
    const mark = await ui.find({ type: 'Text', text: '✠ LEGION' })
    await ui.unmount()
    return mark?.props.color
  }
  expect(await colour('dark')).toBe(palette('dark').accentText)
  expect(await colour('light')).toBe(palette('light').accentText)
})

test('band: draws what waits with its keys, at most three rows then +N more', async ($, on) => {
  mock.clock(on)
  let snap: Snapshot = busy({ band: [{ id: 'b1', kind: 'paused', taskId: 't_000000000002', agentId: 'builder', text: 'Paused at the turn limit', at: 1 }] })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const rows = bandRows(snap, e.props.bodyColumns, e.props.maxRows)
    const { Box } = $.ui.resolve(e)
    return rows.length > 0 ? Rows($.ui.resolve(e), palette('dark'), rows) : <Box />
  })
  for (const surface of SURFACES) {
    for (const w of WIDTHS) {
      const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'AbovePrompt', props: bandProps(w) })
      for (const [key, hotkey] of [['allow:c1', 'a'], ['deny:c1', 'd'], ['continue:t_000000000002', 'c'], ['dismiss:b1', 'x']] as const) {
        expect((await ui.find({ type: 'Button', key }))?.props.hotkey, `${surface}/${w}/${key}`).toBe(hotkey)
        await ui.press({ key, plugin: 'test' })
      }
      await ui.unmount()
    }
  }
  snap = long()
  const many = await $.ui.mount({ plugin: 'legion-mod', surface: 'terminal', component: 'AbovePrompt', props: bandProps(80) })
  expect(await many.find({ type: 'Text', text: /\+124 more · \/legion to open/ })).toBeDefined()
  await many.unmount()
})

test('dispatch: the transcript card draws live and frozen on both surfaces', async ($, on) => {
  mock.clock(on)
  on('ui.render', { component: 'CommandOutput', props: { command: 'to' } }, async ($, e, next) => {
    const rows = dispatchRows(busy(), e.props.text, e.viewport?.columns ?? 80)
    return rows ? Rows($.ui.resolve(e), palette('dark'), rows) : next(e)
  })
  for (const surface of SURFACES) {
    const done = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'CommandOutput', props: { command: 'to', args: 'scribe docs', text: 'Sent · task t_000000000004', isErrored: false } })
    expect(await done.find({ type: 'Text', text: /✎ Scribe/ })).toBeDefined()
    expect(await done.find({ type: 'Text', text: /done/ })).toBeDefined()
    await done.unmount()
    const live = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'CommandOutput', props: { command: 'to', args: 'builder fix', text: 'Sent · task t_000000000001', isErrored: false }, viewport: { columns: 100, rows: 40 } })
    expect(await live.find({ type: 'Button', key: 'allow:c1' })).toBeDefined()
    await live.unmount()
  }
})
