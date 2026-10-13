/**
 * Three ways the UI lost the owner's work or hid a failure (audit 2026-10-13, verified in code):
 * - Esc in the agent editor: App's global Escape closed the editor before the editor's own "unsaved changes" guard ran.
 * - The work-item dialog's Save closed the dialog without the done-when checks typed but not yet saved on their own.
 * - A message sent into a running task that the core refused came back into the box with no word on why.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checksPending } from '../ui/src/projects/board/marshalLogic.js';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

test('Esc: the global handler leaves the agent editor to its own modal, which asks before dropping unsaved edits', () => {
  const app = read('ui/src/App.tsx');
  const esc = /else if \(e\.key === 'Escape'\) \{([^\n]*)\}/.exec(app)?.[1] ?? '';
  assert.ok(esc, 'the Escape clause is found');
  assert.doesNotMatch(esc, /s\.editor/, 'App must not close the agent editor on Escape');
  assert.match(esc, /s\.palette \|\| s\.doctorOpen/);
  const editor = read('ui/src/components/AgentEditor.tsx');
  assert.match(editor, /onClose=\{requestClose\}/, 'the editor modal closes through requestClose, which checks for unsaved edits');
  assert.match(editor, /if \(dirty\) setLeaving\(\{ to: 'close' \}\); else closeOverlays\(\);/);
});

test('done-when checks typed but not saved are pending; the saved text, or only spacing changes, are not', () => {
  assert.equal(checksPending('npm test', ''), true);
  assert.equal(checksPending('npm test', 'npm test'), false);
  assert.equal(checksPending('npm test\n', 'npm test'), false);
  assert.equal(checksPending('', 'npm test'), true, 'clearing the checks is a change too');
});

test('the item dialog Save stores pending done-when checks before it closes, and stays open when that fails', () => {
  const src = read('ui/src/projects/board/BoardPanel.tsx');
  assert.match(src, /if \(item && !item\.proposal && checksPending\(checks, savedKey\) && !\(await storeChecks\(\)\)\) return;/);
  assert.match(src, /const storeChecks = async \(\): Promise<boolean> =>/);
});

test('a refused send into a running task says why, unless it was queued instead', () => {
  const src = read('ui/src/components/Composer.tsx');
  assert.match(src, /if \(r\.status === 409 && enqueueMessage\(aId, tId, raw, effectiveModel\(st\)\)\) return;\n\s*toast\(r\.message, 'error'\);\n\s*setText\(\(cur\) => restoreDraft\(cur, raw\)\);/);
});
