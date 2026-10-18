// test/gates-copy-protected-list.test.ts: one term and one list for what a command still asks about in Bypass (re-review N4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { BYPASS_KEYS_LINE, GATES, PRESET_LINES, PROGRAM_FOLDER_LINE, PROTECTED_FILES_TEXT } from '../src/shared/gates-registry.js';
import { GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';

const LIST = "your gate settings, Legion's settings file, your agents' settings or your projects";

test('N4: the list is one string, in plain words', () => {
  assert.equal(PROTECTED_FILES_TEXT, LIST);
  assert.doesNotMatch(PROTECTED_FILES_TEXT, /config|state|\.json|[\u2014\u2013]/i);
});

test('N4: the Bypass line, the Bypass confirm and the rail row name the same list, and the rail names both mode labels', () => {
  assert.ok(PRESET_LINES.bypass.includes(PROTECTED_FILES_TEXT), PRESET_LINES.bypass);
  const rail = GATES.find((g) => g.id === 'rail-protected-paths')!;
  assert.ok(rail.protects.includes(PROTECTED_FILES_TEXT), rail.protects);
  assert.equal(rail.protects, `File tools cannot change these, or the Armory, in any mode: ${PROTECTED_FILES_TEXT}. In Bypass or Full, a command that changes any of them still asks you first. ${BYPASS_KEYS_LINE} ${PROGRAM_FOLDER_LINE}`);
  assert.doesNotMatch(rail.protects, /projects or the Armory/);
  const store = new GatesStore(join(tempDir('legion-n4-'), 'gates'), { allowed: ['ask', 'accept-edits', 'smart', 'bypass'], signer: makeSigner(Buffer.alloc(32, 5))! });
  const lines = store.preview('app', { preset: 'bypass' }).lines.join('\n');
  assert.ok(lines.includes(PROTECTED_FILES_TEXT), lines);
  assert.doesNotMatch(lines + PRESET_LINES.bypass + rail.protects, /config|state\b/);
});
test('the rail row also names the program folder and the login-start places, once, in plain words', () => {
  const rail = GATES.find((g) => g.id === 'rail-protected-paths')!;
  assert.equal(PROGRAM_FOLDER_LINE, "Outside Bypass, agents also need your yes to change Legion's own program folder and the places that start programs when you log in.");
  assert.equal(rail.protects.split(PROGRAM_FOLDER_LINE).length, 2);
  assert.doesNotMatch(PROGRAM_FOLDER_LINE, /[\u2014\u2013]/);
});
