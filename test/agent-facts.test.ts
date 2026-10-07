/** "What you can do right now": coverage of every registered tool, gates, no overpromising, and where the block sits in a run's prompt. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_WRITE_TOOLS, FACTS_HEADER, INTENTIONALLY_HIDDEN, renderCapabilities, toolNamesOf } from '../src/core/agent-facts.js';
import { listedFor, world } from './agent-facts-helpers.js';

const SERVERS = ['legion', 'legion_comms', 'legion_kg', 'legion_browser', 'legion_blender', 'legion_bsv'];

test('coverage: every registered agent-visible tool of every bot appears in its block, or is intentionally hidden', () => {
  const w = world({ bsv: true, browser: true, blender: true, both: true, polyhaven: true });
  try {
    assert.equal(w.agents.length, 14);
    let seen = 0;
    for (const a of w.agents) {
      const srv = w.servers(a, { vm: true });
      const block = w.block(a, { vm: true });
      for (const s of SERVERS) {
        const names = toolNamesOf(srv[s]);
        if (!names) continue;
        const listed = listedFor(block, s);
        for (const n of names) {
          seen++;
          const hidden = (INTENTIONALLY_HIDDEN[a.id] ?? []).includes(n);
          // the Herald line names the browser write tools in its "do not use" sentence instead of its list
          const named = hidden || listed.includes(n) || (a.id === 'herald' && (BROWSER_WRITE_TOOLS as readonly string[]).includes(n) && block.includes(n));
          assert.ok(named, `${a.id}: tool ${s}/${n} is registered but not in the block`);
        }
      }
    }
    assert.ok(seen > 200, `expected many tools, saw ${seen}`);
    // the gated servers reach only their bot
    for (const a of w.agents) {
      const srv = w.servers(a);
      assert.equal('legion_bsv' in srv, a.id === 'assayer', `${a.id} legion_bsv`);
      assert.equal('legion_blender' in srv, a.id === 'sculptor', `${a.id} legion_blender`);
    }
  } finally { w.dispose(); }
});

test('coverage negative: a tool the block does not name is caught', () => {
  const w = world({ browser: true });
  try {
    const a = w.agents.find((x) => x.id === 'scout')!;
    const srv = w.servers(a);
    const block = w.block(a).replace('browser_text, ', '');
    const listed = listedFor(block, 'legion_browser');
    assert.ok(toolNamesOf(srv.legion_browser)!.some((n) => !listed.includes(n)));
  } finally { w.dispose(); }
});

test('gates: the block names only what this bot really has', () => {
  const off = world();
  const on = world({ bsv: true, browser: true, blender: true });
  try {
    for (const a of off.agents) {
      const b = off.block(a);
      assert.ok(b.startsWith(FACTS_HEADER));
      assert.ok(!/legion_browser|browser_open|bsv_spend_request|bsv_status|blender_exec/.test(b), `${a.id} sees a gated tool while it is off`);
      assert.ok(/VM tools: not available/.test(b), `${a.id} vm line`);
    }
    for (const a of on.agents) {
      const b = on.block(a, { vm: true });
      assert.equal(/bsv_spend_request/.test(b), a.id === 'assayer', `${a.id} bsv`);
      assert.equal(/bsv_status/.test(b), a.id === 'assayer', `${a.id} bsv_status line`);
      assert.equal(/blender_exec/.test(b), a.id === 'sculptor', `${a.id} blender`);
      assert.ok(/browser_open/.test(b), `${a.id} browser on`);
      assert.ok(/vm_exec/.test(b) && !/VM tools: not available/.test(b), `${a.id} vm on`);
      assert.ok(/Inbox/.test(b), `${a.id} inbox line`);
    }
    // vm off for the bot vs no key
    const scout = on.agents.find((x) => x.id === 'scout')!;
    assert.match(on.block(scout), /your VM is off/);
    const forge = on.agents.find((x) => x.id === 'forgemaster')!;
    assert.match(on.block(forge), /no boat\.dev key/);
  } finally { off.dispose(); on.dispose(); }
});

test('Herald: may open, read and list links; the block forbids type, click and eval; others are told cards apply', () => {
  const w = world({ browser: true });
  try {
    const herald = w.block(w.agents.find((a) => a.id === 'herald')!);
    assert.deepEqual(listedFor(herald, 'legion_browser').sort(), ['browser_close', 'browser_links', 'browser_open', 'browser_status', 'browser_text']);
    assert.match(herald, /do not use browser_type, browser_click, browser_eval/);
    const builder = w.block(w.agents.find((a) => a.id === 'builder')!);
    assert.ok(listedFor(builder, 'legion_browser').includes('browser_type'));
    // S5b: the sentence is mode-aware. builder is `full` here, so it is told it will NOT be asked.
    assert.match(builder, /need an approval card in any mode but full — yours is full, so you will not be asked/);
    assert.ok(!/do not use browser_type/.test(builder));
    // and an `ask` agent is told the opposite, so the sentence is never a lie in either direction
    const zealot = w.block(w.agents.find((a) => a.id === 'zealot')!);
    assert.match(zealot, /need an approval card unless your mode is full/);
  } finally { w.dispose(); }
});

test('Assayer: the taint and network facts are stated, with no numbers; Sentinel: no scheduler', () => {
  const w = world({ bsv: true });
  try {
    const assayer = w.block(w.agents.find((a) => a.id === 'assayer')!);
    assert.match(assayer, /marks the run tainted/);
    assert.match(assayer, /second native dialog/);
    assert.match(assayer, /never choose the network/);
    assert.ok(!/\d/.test(assayer.split('\n').filter((l) => l.includes('bsv_status contacts')).join(' ')), 'no numbers in the BSV line');
    const sentinel = w.block(w.agents.find((a) => a.id === 'sentinel')!);
    assert.match(sentinel, /scheduled runs are planned, not available yet/);
    const qm = w.block(w.agents.find((a) => a.id === 'quartermaster')!);
    assert.match(qm, /runs only when the owner or another bot asks; scheduled runs are planned, not available yet/);
    assert.ok(!/scheduled runs are planned/.test(w.block(w.agents.find((a) => a.id === 'scout')!)));
  } finally { w.dispose(); }
});

test('the block never forbids-then-offers: no secrets, no absolute words, short, ceiling shown', () => {
  const w = world({ bsv: true, browser: true, blender: true, both: true, polyhaven: true });
  try {
    for (const a of w.agents) {
      const b = w.block(a, { vm: true });
      assert.ok(!/cannot be bypassed|fully safe|guarantee|100%|always safe|\bsandbox\b/i.test(b), `${a.id}: absolute or stale word`);
      assert.ok(!/[A-Za-z0-9_-]{40,}/.test(b.replace(/legion_[a-z_]+|[a-z_]+(, )?/g, '')), `${a.id}: key-shaped text`);
      assert.ok(b.split('\n').length <= 14, `${a.id}: block too long`);
      assert.ok(b.length < 1800, `${a.id}: ${b.length} chars`);
    }
    const capped = w.block(w.agents.find((a) => a.id === 'builder')!, { ceiling: 'ask' });
    assert.match(capped, /your mode is ask \(capped from full by whoever woke you\)/);
  } finally { w.dispose(); }
});

test('renderCapabilities with a server it cannot read leaves the line out instead of guessing', () => {
  const a = { id: 'x', name: 'X', approval: 'ask', vm: { enabled: false } } as never;
  const b = renderCapabilities(a, { servers: { legion: { type: 'sdk', name: 'legion' } as never }, vmEnabledForAgent: false });
  assert.ok(!b.includes('(legion):'));
});
