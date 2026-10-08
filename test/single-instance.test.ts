/**
 * The desktop app must be exactly one process.
 *
 * ## What this exists for
 *
 * After an in-place update the helper relaunches Legion (`apply.mjs` starts `electron.exe "<install dir>"`), and a
 * pinned Start-menu shortcut or a double-click can start it again while it is already running. Two processes then each
 * build their own window, tray and core, so two Legion windows stack on screen over one core — the owner met this.
 *
 * `app.requestSingleInstanceLock()` is the cure, but only if the answer actually gates the boot. An inline
 * `if (!app.requestSingleInstanceLock()) app.quit()` reads correctly and is invisible to a test, so the branch that
 * quits is pulled into `decideSingleInstance` (instance-logic.ts, no electron import) and asserted here. The wiring
 * that consumes it is asserted structurally, the way test/update-panel-states.test.ts asserts the panel.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { decideSingleInstance } from '../src/electron/instance-logic.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const main = readFileSync(join(REPO, 'src', 'electron', 'main.ts'), 'utf8');

describe('single instance: the first process wins, a second quits', () => {
  it('a process that holds the lock runs and does not quit', () => {
    assert.deepEqual(decideSingleInstance(true), { primary: true, quit: false });
  });

  it('a process that does not get the lock quits and never becomes primary', () => {
    assert.deepEqual(decideSingleInstance(false), { primary: false, quit: true });
  });

  it('negative: a second instance is never primary, which is what stacks two windows over one core', () => {
    // If this ever returned primary:true for a second launch, it would build a window/tray/core of its own — the exact
    // stacking bug. Asserted as its own case so the discriminating property has a name.
    const second = decideSingleInstance(false);
    assert.equal(second.primary, false, 'a second instance that ran as primary would open a second window over one core');
    assert.equal(second.quit, true, 'a second instance that did not quit would keep running');
  });
});

describe('single instance: main.ts is wired to the rule, not to an inline check', () => {
  it('asks Electron for the lock and routes the answer through the pure decision', () => {
    assert.match(main, /app\.requestSingleInstanceLock\(\)/, 'the lock is never requested, so a second launch always runs');
    assert.match(main, /decideSingleInstance\(app\.requestSingleInstanceLock\(\)\)/, 'the lock answer does not reach the pure decision');
  });

  it('quits on the decision before the window/core branch', () => {
    assert.match(main, /if \(instance\.quit\) \{[\s\S]{0,40}app\.quit\(\)[\s\S]{0,20}\} else \{/, 'the quit branch is gone; a second instance would fall through and run');
  });

  it('a second instance brings the existing window forward instead of opening a second one', () => {
    assert.match(main, /app\.on\('second-instance', \(\) => showWindow\(\)\)/, 'a second launch is not routed to the existing window');
  });

  it('negative: main.ts does not keep the old inline `!requestSingleInstanceLock` check', () => {
    // The inline form is what let the rule live untested. Its return would be a regression to "read, never asserted".
    assert.doesNotMatch(main, /if \(!app\.requestSingleInstanceLock\(\)\)/, 'the inline single-instance check came back');
  });
});
