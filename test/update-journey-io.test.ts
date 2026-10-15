/** H2: the step log. Every step is written to the journey file, to apply.log and to app.log with the same id; the new build closes the journey. */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { journeyPath, noteDoneAtStart, readJourneyEvents, readLastJourney, recordStep, type JourneyCtx } from '../src/core/updater/journey-io.js';
import { parseJourneyLine } from '../src/core/updater/journey.js';

const ctx = (install: string, data: string, over: Partial<JourneyCtx> = {}): JourneyCtx => ({ installDir: install, dataDir: data, id: 'ab12cd34', from: '0.3.1', to: '0.3.2', proc: 'core', ...over });
const rig = () => { const root = tempDir('h2-io-'); const install = join(root, 'install'); const data = join(root, 'data'); mkdirSync(install, { recursive: true }); mkdirSync(data, { recursive: true }); return { install, data }; };
const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

test('H2: one step writes one line to the journey file, apply.log and app.log, all with the same id and versions', () => {
  const r = rig();
  recordStep(ctx(r.install, r.data), 'downloading', 'start', { bytes: 0, total: 285_000_000 });
  const j = readJourneyEvents(r.install);
  assert.equal(j.length, 1);
  assert.equal(j[0]!.step, 'downloading'); assert.equal(j[0]!.id, 'ab12cd34'); assert.match(j[0]!.at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const al = lines(join(r.install, '.update', 'apply.log'));
  assert.equal(al.length, 1);
  const parsed = parseJourneyLine(al[0]!);
  assert.deepEqual([parsed?.step, parsed?.id, parsed?.from, parsed?.to, parsed?.proc], ['downloading', 'ab12cd34', '0.3.1', '0.3.2', 'core']);
  const app = lines(join(r.data, 'logs', 'app.log'));
  assert.equal(app.length, 1);
  assert.match(app[0]!, /INFO\s+updater journey-step /); assert.match(app[0]!, /step="downloading"/); assert.match(app[0]!, /id="ab12cd34"/); assert.match(app[0]!, /to="0\.3\.2"/);
});

test('H2: a failure is a warning in app.log and keeps the reason', () => {
  const r = rig();
  recordStep(ctx(r.install, r.data, { proc: 'helper' }), 'failed', 'done', { during: 'installing', note: 'files in use' });
  assert.match(lines(join(r.data, 'logs', 'app.log'))[0]!, /WARN\s+updater journey-step .*note="files in use"/);
  assert.equal(readLastJourney(r.install)?.result, 'failed');
});

test('H2: a new update id starts a fresh journey file; the same id keeps adding to it', () => {
  const r = rig();
  recordStep(ctx(r.install, r.data), 'checking', 'done');
  recordStep(ctx(r.install, r.data), 'downloading', 'start');
  assert.equal(readJourneyEvents(r.install).length, 2);
  recordStep(ctx(r.install, r.data, { id: 'ffffffff', to: '0.3.3' }), 'checking', 'done');
  const ev = readJourneyEvents(r.install);
  assert.deepEqual(ev.map((e) => e.id), ['ffffffff']);
  assert.equal(readLastJourney(r.install)?.to, '0.3.3');
});

test('H2: a missing data folder is fine: the journey file and apply.log are still written', () => {
  const r = rig();
  recordStep({ installDir: r.install, id: 'ab12cd34', from: '0.3.1', to: '0.3.2', proc: 'helper' }, 'closing', 'start');
  assert.equal(readJourneyEvents(r.install).length, 1);
  assert.equal(lines(join(r.install, '.update', 'apply.log')).length, 1);
});

test('H2: the new build closes the journey once: Done is written by the new app, only for the version it runs, only after the swap', () => {
  const r = rig();
  const helper = ctx(r.install, r.data, { proc: 'helper' });
  recordStep(helper, 'closing', 'done'); recordStep(helper, 'installing', 'start');
  assert.equal(noteDoneAtStart(r.install, r.data, '0.3.2'), false, 'the swap has not finished: not done yet');
  recordStep(helper, 'installing', 'done');
  assert.equal(noteDoneAtStart(r.install, r.data, '0.3.1'), false, 'a build that is not the target never closes it');
  assert.equal(noteDoneAtStart(r.install, r.data, '0.3.2'), true);
  assert.equal(noteDoneAtStart(r.install, r.data, '0.3.2'), false, 'only once');
  const done = readJourneyEvents(r.install).filter((e) => e.step === 'done');
  assert.equal(done.length, 1); assert.equal(done[0]!.proc, 'new-app'); assert.equal(done[0]!.id, 'ab12cd34');
  assert.equal(readLastJourney(r.install)?.result, 'ok');
});

test('H2: a damaged journey file reads as no journey, never as an error', () => {
  const r = rig();
  mkdirSync(join(r.install, '.update'), { recursive: true });
  writeFileSync(journeyPath(r.install), '\u0000\u0000 not json\n{"half":');
  assert.equal(readLastJourney(r.install), null);
  assert.deepEqual(readJourneyEvents(r.install), []);
});
