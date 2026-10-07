/**
 * The Legion UI through the plugin itself: registerUi's hooks reading `$.state`, fed from beneath by the test's
 * `state.get` hook, drawn on the terminal and desktop.
 *
 * The status line's hook (`state.set` on the mod's keys) is not exercised here: a test's `$` carries no `state`
 * noun to raise that write with. Its text is covered by test/node/ui/status.spec.ts.
 *
 * NEEDS THE WIRING: these tests pass once hooks/register.tsx calls `registerUi(on)` (src/ui/test-entry.md).
 * Until then the plugin draws nothing of its own and they fail with "no implementation for ui.render".
 */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Snapshot } from '../../src/ui/views/common.ts'
import { base, busy, DOCTOR } from '../node/ui/fixtures.ts'

const SURFACES = ['terminal', 'desktop'] as const
const paneProps = (bodyColumns: number) => ({ title: 'Legion', isFocused: true, bodyColumns, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} })
const bandProps = (bodyColumns: number, hasSurvey = false) => ({ hasSurvey, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} })

/** Answers the plugin's `$.state.get` from a snapshot, as the host would: `{ value: { value, version } }`. */
const feed = (on: On, get: () => Snapshot, theme: () => 'dark' | 'light' = () => 'dark'): void => {
  mock.clock(on, { now: 1_000_000 })
  on('state.get', async (_$, e) => {
    const s = get()
    const v: Record<string, unknown> = { agents: s.agents, tasks: s.tasks, cards: s.cards, ui: s.ui, moods: s.moods, band: s.band, theme: theme(), sessionId: s.sessionId, doctor: s.doctor }
    const value = e.key === 'threads' ? s.thread : e.key === 'live' ? s.live : v[e.key]
    return { value: { value: value as never, version: value === undefined ? 0 : 1 } }
  })
}

test('wired pane: draws from state on both surfaces, and its keys are there', async ($, on) => {
  feed(on, () => busy())
  for (const surface of SURFACES) {
    for (const w of [40, 80, 120, 200]) {
      const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: 'legion', props: paneProps(w) })
      expect(await ui.find({ type: 'Text', text: '✠ LEGION' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'stop:t_000000000001' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'keys:open' }))?.props.hotkey).toBe('k')
      await ui.unmount()
    }
  }
})

test('wired pane: the light theme from state draws the light accent', async ($, on) => {
  feed(on, () => busy(), () => 'light')
  const ui = await $.ui.mount({ plugin: 'legion-mod', surface: 'terminal', component: 'Pane', requestId: 'legion', props: paneProps(100) })
  expect((await ui.find({ type: 'Text', text: '✠ LEGION' }))?.props.color).toBe('#087a47')
  await ui.unmount()
})

test('wired band: draws what waits; passes when empty and when a survey holds the band', async ($, on) => {
  let snap: Snapshot = busy()
  feed(on, () => snap)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  for (const surface of SURFACES) {
    snap = busy()
    let ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'AbovePrompt', props: bandProps(80) })
    expect(await ui.find({ type: 'Text', text: /in the dialog/ })).toBeDefined()
    await ui.unmount()
    ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'AbovePrompt', props: bandProps(80, true) })
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
    snap = base()
    ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'AbovePrompt', props: bandProps(80) })
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await ui.unmount()
  }
})

test('wired dispatch: a /to row naming a task draws the card; one naming none is the engine\'s', async ($, on) => {
  feed(on, () => busy())
  on('ui.render', { component: 'CommandOutput' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })
  for (const surface of SURFACES) {
    for (const command of ['to', 'say'] as const) {
      let ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'CommandOutput', props: { command, args: 'x', text: 'Sent · task t_000000000004', isErrored: false } })
      expect(await ui.find({ type: 'Text', text: /✎ Scribe/ })).toBeDefined()
      await ui.unmount()
      ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'CommandOutput', props: { command, args: 'x', text: 'No agent called that.', isErrored: false } })
      expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
      await ui.unmount()
    }
  }
})

test("wired press: a Legion Button's press reaches ui.press with its action key, for the lead's hook to answer", async ($, on) => {
  feed(on, () => busy())
  const pressed: string[] = []
  on('ui.press', async (_$, e, next) => {
    pressed.push(String(e.element))
    return next(e)
  })
  for (const surface of SURFACES) {
    pressed.length = 0
    const ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: 'legion', props: paneProps(120) })
    for (const key of ['view:order', 'keys:open', 'stop:t_000000000001']) await ui.press({ key })
    expect(pressed).toEqual(['view:order', 'keys:open', 'stop:t_000000000001'])
    await ui.unmount()
  }
})

test("wired pane: the window's session id and the doctor run come from state", async ($, on) => {
  let snap: Snapshot = busy({ sessionId: 'me', live: '' })
  feed(on, () => snap)
  for (const surface of SURFACES) {
    snap = busy({ sessionId: 'me', live: '' })
    let ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: 'legion', props: paneProps(100) })
    expect(await ui.find({ type: 'Text', text: /in another window/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'stop:t_000000000001' })).toBeUndefined()
    await ui.unmount()
    snap = busy({ doctor: DOCTOR, ui: { view: 'order', agentId: 'builder', taskId: null, channel: null } })
    ui = await $.ui.mount({ plugin: 'legion-mod', surface, component: 'Pane', requestId: 'legion', props: paneProps(100) })
    expect(await ui.find({ type: 'Text', text: /legion-mod-runner is not running/ })).toBeDefined()
    await ui.unmount()
  }
})
