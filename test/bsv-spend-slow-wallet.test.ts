/**
 * Regression for the flaky 180 s timeout of dist/test/bsv-spend-flow.test.js (windows CI, shard 3/4). The spend tool
 * answers pending-wallet while the build is still probing the wallet over real sockets, so a wallet slower than the
 * tool's fixed wait makes its grant question arrive AFTER a test has looked for it (the scenarios assert
 * `heldGrants() === 1` right after askOnce). A test that then ends runs `finally { await r.close() }`, and close()
 * must still answer that question when it arrives: one left open holds its createAction (and so settle()) for
 * SPEND_LIMITS.createTimeoutMs (15 minutes), longer than CI's --test-timeout=180000, which reports it as a file
 * timeout with the real assertion lost inside.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { args, loadMods, rig } from './bsv-spend-scenarios.js';
import { TEST_A } from './bsv-net-helpers.js';

// tests run from dist/test; the compiled sources are one level up
const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('slow wallet: close() answers a grant question that arrives after the test ended', async () => {
  const M = await loadMods(ROOT);
  // netDelayMs 500: the probe takes much longer than askOnce's fixed wait (120 ms tool wait + 25 ms), as a loaded CI runner does
  const r = await rig(M, { wallet: { grant: 'toolbox', netDelayMs: 500 } });
  try {
    await r.setup({ allow: { test: [TEST_A] } });
    const first = await r.askOnce(args());
    assert.equal(first.status, 'pending-wallet');
    // the test ends here, before the wallet's grant question has arrived
  } finally {
    let closed = false;
    const done = r.close().then(() => { closed = true; });
    await Promise.race([done, new Promise((x) => setTimeout(x, 10_000))]);
    const stuck = !closed;
    if (stuck) { while (r.w.heldGrants() > 0) r.w.answerGrant('deny'); await done; } // repair, so the failure is a clean red
    assert.equal(stuck, false, 'close() must answer a grant question that arrives late instead of waiting out the 15-minute create cap');
    assert.equal(r.w.aborted.length, 1, 'the late question was answered and its build released');
    assert.equal(r.w.of('signAction').length, 0);
  }
});

test('slow wallet: walletQuestion() waits for the question instead of racing it', async () => {
  const M = await loadMods(ROOT);
  const r = await rig(M, { wallet: { grant: 'toolbox', netDelayMs: 500 } });
  try {
    await r.setup({ allow: { test: [TEST_A] } });
    const first = await r.askOnce(args());
    assert.equal(first.status, 'pending-wallet');
    await r.walletQuestion();
    assert.equal(r.w.heldGrants(), 1, 'the wait ends when the wallet is actually asking its owner');
    r.w.answerGrant('deny');
    await r.settle();
    assert.equal(r.w.of('signAction').length, 0);
  } finally { await r.close(); }
});
