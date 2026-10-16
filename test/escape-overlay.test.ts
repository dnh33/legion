/** Esc closes only the topmost overlay: the command palette over a dialog closes the palette, and the dialog stays. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { escapeAction } from '../ui/src/escapeLogic.js';

const base = { palette: false, doctorOpen: false, settingsOpen: false, dialogOpen: false, inField: false };

test('the palette closes alone, even over a dialog', () => {
  assert.equal(escapeAction({ ...base, palette: true }), 'palette');
  assert.equal(escapeAction({ ...base, palette: true, dialogOpen: true, settingsOpen: true }), 'palette');
});
test('the doctor panel closes through the general close', () => {
  assert.equal(escapeAction({ ...base, doctorOpen: true }), 'overlays');
});
test('settings closes on Esc only when no dialog is open and the focus is not in a field', () => {
  assert.equal(escapeAction({ ...base, settingsOpen: true }), 'settings');
  assert.equal(escapeAction({ ...base, settingsOpen: true, dialogOpen: true }), null);
  assert.equal(escapeAction({ ...base, settingsOpen: true, inField: true }), null);
});
test('nothing open, nothing to do', () => assert.equal(escapeAction(base), null));

test('App prevents the default on a handled Esc and Modal ignores an Esc that is already handled', () => {
  const app = readFileSync(join(process.cwd(), 'ui/src/App.tsx'), 'utf8');
  const modal = readFileSync(join(process.cwd(), 'ui/src/components/Modal.tsx'), 'utf8');
  assert.match(app, /escapeAction\(/);
  assert.match(modal, /e\.key === 'Escape' && !e\.defaultPrevented/);
});
