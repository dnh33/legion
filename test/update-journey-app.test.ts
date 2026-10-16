/** H2: the app's side of the journey: the job carries the update id, the data folder and the window choice; the app writes step 5; the start gate shows the same window look. */
import { tempDir } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildJob, commitMatches } from '../src/core/updater/main-logic.js';
import { gateModel } from '../src/core/updater/update-window-logic.js';
import { foldJourney, type JourneyEvent } from '../src/core/updater/journey.js';

const REPO = join(import.meta.dirname, '..', '..');
const install = tempDir('h2-app-');
const commit = { installDir: install, stagedDir: join(install, '.update', 'staging', '1.1.0', 'x'), from: '1.0.0', to: '1.1.0', updateId: 'ab12cd34' };

test('H2 app: the job carries the one update id, the data folder and whether to show the window, and the user-data folder the window takes the lock under', () => {
  const j = buildJob(commit, { parentPid: 9, port: 4747, execPath: 'electron.exe', dataDir: 'D:/data', window: { enabled: true, userData: 'C:/Users/x/AppData/Roaming/legion' } });
  assert.equal(j.updateId, 'ab12cd34'); assert.equal(j.dataDir, 'D:/data');
  assert.deepEqual(j.window, { enabled: true, userData: 'C:/Users/x/AppData/Roaming/legion' });
  assert.equal(j.relaunch.env?.LEGION_UPDATE_HANDOFF, '1', 'the helper\'s relaunch still announces itself');
  const off = buildJob(commit, { parentPid: 9, port: 4747, execPath: 'e', dataDir: 'D:/data', window: { enabled: false, userData: 'u' } });
  assert.equal(off.window?.enabled, false);
  const old = buildJob({ ...commit, updateId: undefined }, { parentPid: 9, port: 4747, execPath: 'e' });
  assert.equal('updateId' in old, false); assert.equal('window' in old, false);
});

test('H2 app: a commit answer with a malformed update id is refused (the id ends up in file names and log lines)', () => {
  assert.equal(commitMatches(commit, install), true);
  assert.equal(commitMatches({ ...commit, updateId: '../../x' }, install), false);
  assert.equal(commitMatches({ ...commit, updateId: undefined }, install), true, 'an older core sends none');
  assert.ok(sep.length > 0);
});

test('H2 app: the start gate shows the same window look: the model without buttons (a gate cannot retry), and a plain waiting line before any step', () => {
  const m = gateModel(null, '1.1.0');
  assert.equal(m.title, 'Legion is finishing an update'); assert.equal(m.subtitle, 'to 1.1.0'); assert.deepEqual(m.buttons, []);
  const ev = (step: JourneyEvent['step'], state: JourneyEvent['state'], o: Partial<JourneyEvent> = {}): JourneyEvent => ({ at: 'x', id: 'ab12cd34', step, state, proc: 'helper', from: '1.0.0', to: '1.1.0', ...o });
  const g = gateModel(foldJourney([ev('closing', 'done'), ev('installing', 'start')]), '1.1.0');
  assert.equal(g.title, 'Legion is finishing an update'); assert.ok(g.rows.some((r) => r.label === 'Installing' && r.state === 'active'));
  const f = gateModel(foldJourney([ev('closing', 'start'), ev('failed', 'done', { during: 'closing', note: 'files in use' })]), '1.1.0');
  assert.deepEqual(f.buttons, []); assert.match(f.message ?? '', /Some files were in use/);
});

test('H2 app: updater-main copies the window files before it starts the helper, writes step 5 from the app, closes the journey in the new build, and loads the shared page for the start gate', () => {
  const src = readFileSync(join(REPO, 'src', 'electron', 'updater-main.ts'), 'utf8');
  assert.match(src, /copyWindowFiles\(h\.installDir\)/);
  assert.ok(src.indexOf('copyWindowFiles(h.installDir)') < src.indexOf("spawn(plan.cmd"), 'the files are out of the install before the helper starts');
  assert.match(src, /recordStep\([^)]*proc: 'app'[^)]*\)?[^;]*'closing', 'start'/s);
  assert.match(src, /noteDoneAtStart\(/);
  assert.match(src, /update-window\.html/);
  assert.match(src, /noticeAfterWindow\(/);
});
