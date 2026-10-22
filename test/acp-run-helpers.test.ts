import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERMES_SELF_DENY_MS, MAX_CARD_WAIT_MS, permissionWaitOf, plainWindowsPath, requestPaths } from '../src/core/acp/run-helpers.js';

// Pure pieces of an agent host run. Hermes joins the paths of a multi-file patch with ", " (acp_adapter/edit_approval.py:106-126)
// and reads the patch headers with the two regexes at edit_approval.py:49-50.
const BS = String.fromCharCode(92);

test('plainWindowsPath: long-path, device and NT object spellings read as the plain path; one Legion cannot read is undefined', () => {
  const D = `C:${BS}Users${BS}me${BS}data`;
  assert.equal(plainWindowsPath(D), D, 'a plain path is left alone');
  assert.equal(plainWindowsPath(`${BS}${BS}?${BS}${D}`), D);
  assert.equal(plainWindowsPath(`//?/${D}`), D);
  assert.equal(plainWindowsPath(`${BS}${BS}.${BS}${D}`), D);
  assert.equal(plainWindowsPath(`${BS}??${BS}${D}`), D);
  assert.equal(plainWindowsPath(`${BS}${BS}?${BS}UNC${BS}localhost${BS}C$${BS}Users`), `${BS}${BS}localhost${BS}C$${BS}Users`);
  assert.equal(plainWindowsPath(`${BS}${BS}.${BS}UNC${BS}host${BS}share${BS}x`), `${BS}${BS}host${BS}share${BS}x`);
  assert.equal(plainWindowsPath(`${BS}${BS}host${BS}share${BS}x`), `${BS}${BS}host${BS}share${BS}x`, 'a plain network path is not a device path');
  for (const odd of [`${BS}${BS}?${BS}Volume{0000-0000}${BS}x`, `${BS}${BS}?${BS}GLOBALROOT${BS}Device${BS}HarddiskVolume3${BS}x`, `${BS}${BS}.${BS}PhysicalDrive0`, `${BS}${BS}?${BS}`]) {
    assert.equal(plainWindowsPath(odd), undefined, odd);
  }
});

test('requestPaths: a joined display string is split, the patch headers are read, and what cannot be read says so', () => {
  const mk = (over: Record<string, unknown>) => ({ toolName: 'Write', input: {}, ...over }) as Parameters<typeof requestPaths>[0];
  const joined = requestPaths(mk({ input: { file_path: 'a.txt, /x/y/gates' } }), 'linux');
  assert.deepEqual([...joined.paths].sort(), ['/x/y/gates', 'a.txt', 'a.txt, /x/y/gates'].sort());
  assert.equal(joined.unreadable, undefined);
  const body = ['*** Begin Patch', '*** Update File: one.txt', '*** Add File: two.txt', '*** Delete File: three.txt', '*** Move File: four.txt -> five.txt', '*** End Patch'].join('\r\n');
  const fromBody = requestPaths(mk({ input: { patch: body, mode: 'patch' } }), 'linux');
  assert.deepEqual([...fromBody.paths].sort(), ['five.txt', 'four.txt', 'one.txt', 'three.txt', 'two.txt']);
  assert.ok(requestPaths(mk({ input: { file_path: 7 } }), 'linux').unreadable, 'not a string');
  assert.ok(requestPaths(mk({ input: { file_path: 'a\u0000b' } }), 'linux').unreadable, 'a NUL');
  assert.ok(requestPaths(mk({ input: {} }), 'linux').unreadable, 'an edit that names no file');
  assert.equal(requestPaths(mk({ toolName: 'Bash', input: { command: 'ls' } }), 'linux').unreadable, undefined, 'a command names no file and that is fine');
  assert.ok(requestPaths(mk({ input: { file_path: `${BS}${BS}localhost${BS}C$${BS}x` } }), 'win32').unreadable, 'an administrative share');
  assert.deepEqual(requestPaths(mk({ input: { file_path: `${BS}${BS}?${BS}C:${BS}x${BS}y` } }), 'win32').paths, [`C:${BS}x${BS}y`]);
});

test('permissionWaitOf: a huge or odd value is clamped to what a card can wait, and never to a value a timer reads as 1 ms', () => {
  assert.equal(permissionWaitOf(500), 500);
  assert.equal(permissionWaitOf(() => 7_000), 7_000);
  assert.equal(permissionWaitOf(undefined), HERMES_SELF_DENY_MS);
  assert.equal(permissionWaitOf(NaN), HERMES_SELF_DENY_MS);
  assert.equal(permissionWaitOf(-5), HERMES_SELF_DENY_MS);
  assert.equal(permissionWaitOf(Infinity), HERMES_SELF_DENY_MS);
  assert.equal(permissionWaitOf(3_000_000_000), MAX_CARD_WAIT_MS);
  assert.equal(permissionWaitOf(() => Number.MAX_VALUE), MAX_CARD_WAIT_MS);
  assert.ok(MAX_CARD_WAIT_MS < 2 ** 31 - 1 && MAX_CARD_WAIT_MS > HERMES_SELF_DENY_MS);
});
