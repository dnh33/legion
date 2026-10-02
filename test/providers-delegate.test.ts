import test from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';
import { DELEGATE_ONLY_DISALLOWED } from '../src/core/engine.js';

test('C optional delegate-only: off by default; on, the lead loses its own Bash, Write, Edit and NotebookEdit (and keeps the delegation tools)', async () => {
  const f = await startFake(() => undefined);
  try {
    const off = setup(f, { agent: { model: 'sonnet' } });
    await run(off);
    const offDis: string[] = off.claudeCalls[0].options.disallowedTools;
    for (const t of DELEGATE_ONLY_DISALLOWED) assert.equal(offDis.includes(t), false, `${t} stays available by default`);
    const on = setup(f, { agent: { model: 'sonnet', delegateOnly: true } });
    await run(on);
    const onDis: string[] = on.claudeCalls[0].options.disallowedTools;
    for (const t of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(onDis.includes(t), t);
    assert.equal(onDis.includes('Read'), false); assert.equal(onDis.some((t) => /ask|tell|legion/i.test(t) && t !== 'SendMessage'), false);
  } finally { await f.close(); }
});
