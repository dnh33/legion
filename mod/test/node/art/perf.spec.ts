import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnimState, poseAt } from '../../../src/art/animator.ts'
import { compose } from '../../../src/art/compose.ts'
import { pack } from '../../../src/art/pack.ts'
import { AGENTS, loadArt } from './load.ts'

// A timing test means nothing under other load (kodawari: measure relatively, never while other heavy work runs), and
// `node --test` runs spec files in parallel. So this one runs alone: LEGION_MOD_PERF=1, or `npm run test:perf` in mod/.
const PERF_SKIP = process.env.LEGION_MOD_PERF === '1' ? false : 'run alone: LEGION_MOD_PERF=1 node --experimental-transform-types --test mod/test/node/art/perf.spec.ts'

test('compose + pack of 600 frames averages well under 1 ms a frame', { skip: PERF_SKIP }, () => {
  const arts = AGENTS.map(loadArt)
  // warm up (JIT, palette caches)
  for (const a of arts) pack(compose(a.stage, poseAt(a, createAnimState(a, 0, 'thinking', { seed: 1 }), 100, true)), { panel: 0x12151a })
  const t0 = performance.now()
  let bytes = 0
  for (let i = 0; i < 600; i++) {
    const a = arts[i % arts.length]!
    const mood = (['idle', 'thinking', 'hacking', 'awaiting', 'error'] as const)[i % 5]!
    const st = createAnimState(a, 0, mood, { seed: i })
    bytes += pack(compose(a.stage, poseAt(a, st, i * 83, true)), { panel: 0x12151a }).length
  }
  const per = (performance.now() - t0) / 600
  console.log(`2D Order: ${per.toFixed(4)} ms per frame (compose + pack, 32x18 cells), ${bytes / 600} base64 chars per frame`)
  assert.ok(per < 0.5, `${per} ms per frame`)
})
