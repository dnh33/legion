// test/engine-run-chips.test.ts: the engine records, per run, how it asks (Task.runsAs) and what it read on the web (Task.web), so the run header can show both.
// Counts only: never an address or a query.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';

type Opts = Parameters<typeof gatesRig>[0];
const using = async (o: Opts, body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const taskOf = (r: GatesRig) => r.store.getTask(r.task.id)!;
const url = (u: string) => ({ url: u });

test('a run records how it asks and the project it started in', () => using({ preset: 'smart', follow: true }, async (r) => {
  const t = taskOf(r);
  assert.deepEqual(t.runsAs, { mode: 'smart', projectId: r.project.id });
}));

test('an agent on its own mode records that mode; the project cap shows in the mode', () => using({ preset: 'ask', own: 'full' }, async (r) => {
  assert.equal(taskOf(r).runsAs?.mode, 'ask', 'Full on its own, limited to Ask by the project');
}));

test('a run that read nothing has no web summary', () => using({ preset: 'smart', follow: true }, async (r) => {
  assert.equal(taskOf(r).web, undefined);
}));

test('distinct pages are counted once each, host and path only', () => using({ preset: 'smart', follow: true }, async (r) => {
  await r.call('WebFetch', url('https://docs.python.org/3/library/os.html'));
  await r.call('WebFetch', url('https://docs.python.org/3/library/os.html'));
  await r.call('WebFetch', url('https://docs.python.org/3/library/re.html'));
  assert.deepEqual(taskOf(r).web, { pages: 2, newSites: 0 });
  assert.deepEqual(Object.keys(taskOf(r).web!).sort(), ['newSites', 'pages'], 'counts only');
  assert.doesNotMatch(JSON.stringify(taskOf(r)), /os\.html|re\.html|docs\.python/, 'no address is kept on the task');
}));

test('a new site the owner approves on a card counts as one new site and one page', () => using({ preset: 'smart', follow: true }, async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a'));
  await r.tick(200);
  assert.equal(r.pending().length, 1);
  assert.equal(taskOf(r).web, undefined, 'nothing is read while the card waits');
  r.answer(true);
  assert.equal((await p).allow, true);
  assert.deepEqual(taskOf(r).web, { pages: 1, newSites: 1 });
}));

test('a site the owner turns down adds nothing', () => using({ preset: 'smart', follow: true }, async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a'));
  await r.tick(200);
  r.answer(false);
  assert.equal((await p).allow, false);
  assert.equal(taskOf(r).web, undefined);
}));
