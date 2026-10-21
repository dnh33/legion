/** The window side of the core restart: the notice, the stopped banner with its button, and the Settings switch. Every string and every state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './ps-helpers.js';
import {
  CORE_OPTION_HINT, CORE_OPTION_LABEL, CORE_RESTARTED_TEXT, CORE_STOPPED_FAILED_TEXT, CORE_STOPPED_LIMIT_TEXT, CORE_STOPPED_STARTING_TEXT, bannerModel, nextOption, type BannerInput,
} from '../ui/src/coreRestart/coreRestartText.js';

const src = (p: string): string => readFileSync(join(repoRoot, p), 'utf8').replace(/\r\n/g, '\n');
const input = (over: Partial<BannerInput> = {}): BannerInput => ({ restarted: false, stopped: null, dismissed: false, busy: false, error: null, ...over });

test('words: the restart notice, exactly', () => {
  assert.equal(CORE_RESTARTED_TEXT, 'Legion Core stopped unexpectedly and was restarted. Running tasks were stopped.');
});

test('words: the limit banner says 3 times in 5 minutes and points to core.log', () => {
  assert.equal(CORE_STOPPED_LIMIT_TEXT, 'Legion Core stopped 3 times in 5 minutes, so Legion did not restart it again. Details are in core.log in your data folder (Settings, About).');
});

test('words: a restart that did not come up says so and points to core.log', () => {
  assert.equal(CORE_STOPPED_FAILED_TEXT, 'Legion Core stopped unexpectedly and could not be restarted. Details are in core.log in your data folder (Settings, About).');
});

test('words: a core that stopped while Legion was starting says that, not "could not be restarted"', () => {
  assert.equal(CORE_STOPPED_STARTING_TEXT, 'Legion Core stopped while Legion was starting. Use Restart core to start it again. Details are in core.log in your data folder (Settings, About).');
  assert.ok(!/restarted/.test(CORE_STOPPED_STARTING_TEXT));
  assert.equal(bannerModel(input({ stopped: 'starting' }))!.text, CORE_STOPPED_STARTING_TEXT);
  assert.equal(bannerModel(input({ stopped: 'starting' }))!.action, 'restart');
  assert.match(src('ui/src/coreRestart/coreRestartStore.ts'), /v === 'starting'/, 'the store accepts the reason');
});

test('words: the Settings line and its hint', () => {
  assert.equal(CORE_OPTION_LABEL, 'Restart Legion Core when it stops unexpectedly');
  assert.match(CORE_OPTION_HINT, /^If Legion Core stops on its own, Legion starts it again/);
  assert.match(CORE_OPTION_HINT, /3 stops in 5 minutes/);
});

test('words: no em dash, no "this computer", no outside product names', () => {
  for (const t of [CORE_RESTARTED_TEXT, CORE_STOPPED_LIMIT_TEXT, CORE_STOPPED_FAILED_TEXT, CORE_STOPPED_STARTING_TEXT, CORE_OPTION_LABEL, CORE_OPTION_HINT]) {
    assert.ok(!t.includes('\u2014'), t);
    assert.ok(!/this (computer|machine)/i.test(t), t);
  }
});

test('banner: nothing to show when the core is fine', () => {
  assert.equal(bannerModel(input()), null);
});

test('banner: after a restart, a notice with Dismiss', () => {
  assert.deepEqual(bannerModel(input({ restarted: true })), { tone: 'info', role: 'status', text: CORE_RESTARTED_TEXT, action: 'dismiss', actionLabel: 'Dismiss', actionDisabled: false });
});

test('banner: a dismissed notice is gone', () => {
  assert.equal(bannerModel(input({ restarted: true, dismissed: true })), null);
});

test('banner: at the limit, an alert with Restart core', () => {
  assert.deepEqual(bannerModel(input({ stopped: 'limit' })), { tone: 'stop', role: 'alert', text: CORE_STOPPED_LIMIT_TEXT, action: 'restart', actionLabel: 'Restart core', actionDisabled: false });
});

test('banner: a stop cannot be dismissed, only restarted', () => {
  const m = bannerModel(input({ stopped: 'limit', dismissed: true, restarted: true }))!;
  assert.equal(m.action, 'restart');
  assert.equal(m.text, CORE_STOPPED_LIMIT_TEXT);
});

test('banner: while the restart runs the button says so and is off', () => {
  const m = bannerModel(input({ stopped: 'limit', busy: true }))!;
  assert.equal(m.actionLabel, 'Restarting\u2026');
  assert.equal(m.actionDisabled, true);
});

test('banner: a restart that failed shows its own words, and an error from the button is added', () => {
  assert.equal(bannerModel(input({ stopped: 'failed' }))!.text, CORE_STOPPED_FAILED_TEXT);
  const m = bannerModel(input({ stopped: 'limit', error: 'The core on the port did not stop.' }))!;
  assert.equal(m.text, `${CORE_STOPPED_LIMIT_TEXT} Restart failed: The core on the port did not stop.`);
});

test('option: a real boolean from the reply is used, anything else stays on', () => {
  assert.equal(nextOption({ ok: true, enabled: false }), false);
  assert.equal(nextOption({ ok: true, enabled: true }), true);
  assert.equal(nextOption(undefined), true);
  assert.equal(nextOption({ ok: false, enabled: false, error: 'x' }), false, 'the answer main gives is the truth, even after a failed save');
  assert.equal(nextOption({ enabled: 'no' }), true);
});

test('wiring: the banner sits above the views, the thread does not repeat it, Settings has the line', () => {
  const app = src('ui/src/App.tsx');
  assert.match(app, /<CoreRestartBanner \/>/);
  assert.match(app, /startCoreRestart\(\)/);
  const thread = src('ui/src/components/Thread.tsx');
  assert.match(thread, /conn === 'offline' && !coreStopped && agents\.length > 0/);
  const settings = src('ui/src/components/Settings.tsx');
  assert.match(settings, /<CoreRestartRow \/>/);
  const api = src('ui/src/api.ts');
  for (const fn of ['coreRestartState', 'onCoreRestartChanged', 'restartCoreNow', 'coreRestartOption']) assert.ok(api.includes(`${fn}?(`), fn);
});

test('component: the banner uses role from the model, a real button, and no side stripe', () => {
  const c = src('ui/src/coreRestart/CoreRestartBanner.tsx');
  assert.match(c, /role=\{m\.role\}/);
  assert.match(c, /<button type="button"/);
  const css = src('ui/src/styles/app.css');
  const block = css.slice(css.indexOf('.core-note {'), css.indexOf('/* end core-note */'));
  assert.ok(block.length > 40);
  assert.match(block, /margin: 10px 24px 8px;/, 'a gap under the banner as well as over it');
  assert.ok(!/border-left|border-inline-start|inset 2px/.test(block), 'state is a tinted fill with a full hairline');
});

test('component: the Settings row is a labelled checkbox that reads and writes through main', () => {
  const c = src('ui/src/coreRestart/CoreRestartRow.tsx');
  assert.match(c, /type="checkbox"/);
  assert.match(c, /CORE_OPTION_LABEL/);
  assert.match(c, /CORE_OPTION_HINT/);
  assert.match(c, /coreRestartOption/);
});
