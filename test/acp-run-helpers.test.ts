import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandRequestPath, HERMES_SELF_DENY_MS, hermesHomes, MAX_CARD_WAIT_MS, permissionWaitOf, plainWindowsPath, requestPaths, stripPaths } from '../src/core/acp/run-helpers.js';

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

test('requestPaths: a patch header is read the way Hermes applies it (no space after the stars, move to a second path)', () => {
  const mk = (patch: string) => ({ toolName: 'Write', input: { patch }, }) as Parameters<typeof requestPaths>[0];
  const got = requestPaths(mk(['*** Begin Patch', '***Update File: a.txt', '***   Add   File:   b.txt  ', '*** Move File:  c.txt   ->   d.txt ', '*** End Patch'].join('\n')), 'linux');
  assert.deepEqual([...got.paths].sort(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  assert.equal(got.unreadable, undefined);
});

test('requestPaths: a patch full of whitespace is read in linear time, and a patch too long to scan is unreadable (fails closed)', () => {
  const mk = (patch: string) => ({ toolName: 'Write', input: { patch }, }) as Parameters<typeof requestPaths>[0];
  const time = (patch: string): number => { const t = process.hrtime.bigint(); requestPaths(mk(patch), 'linux'); return Number(process.hrtime.bigint() - t) / 1e6; };
  const spaces = ' '.repeat(200_000);
  // the shapes that made the old pattern quadratic, and the shapes a nested-quantifier rewrite would still be slow on
  const shapes = [`*** Move File: a${spaces}`, `*** Move File:${spaces}x`, `***${spaces}Update File: a`, `*** Update File:${spaces}`, `*** Move File: a${spaces}-${spaces}>${spaces}`, `*** Move File: ${'a ->'.repeat(50_000)}`];
  time(shapes[0]!); // warm up
  for (const s of shapes) {
    const ms = time(s);
    assert.ok(ms < 250, `a ${s.length}-character line took ${ms.toFixed(1)} ms`); // the old pattern took seconds; the bound is wide for a loaded machine
  }
  const big = requestPaths(mk(`*** Update File: a.txt\n${'x\n'.repeat(700_000)}*** Update File: ../later.txt`), 'linux');
  assert.ok(big.unreadable, 'a header past the scanned part must not be missed');
});

test('stripPaths: a local path in text from Hermes or the system becomes [path]; ordinary words and short names stay', () => {
  const B = String.fromCharCode(92);
  const cases: Array<[string, string]> = [
    [`FileNotFoundError: C:${B}Users${B}jane${B}AppData${B}Local${B}hermes${B}config.yaml not found`, 'FileNotFoundError: [path] not found'],
    [`failed at ${B}${B}server${B}share${B}x${B}y.txt now`, 'failed at [path] now'],
    ['error in /home/jane/.hermes/config.yaml: bad', 'error in [path]: bad'],
    ['cannot open /Users/jane/Library/x', 'cannot open [path]'],
    ['cannot open ~/.hermes/auth.json', 'cannot open [path]'],
    ['(C:/tools/hermes.exe)', '([path])'],
    ['spawn hermes ENOENT', 'spawn hermes ENOENT'],
    ['the api/v1/users endpoint answered 500', 'the api/v1/users endpoint answered 500'],
    ['Hermes failed. Internal error', 'Hermes failed. Internal error'],
  ];
  for (const [input, want] of cases) assert.equal(stripPaths(input), want, input);
});

test('requestPaths: a path with ", " inside it is checked whole even when it is not the first piece of the join', () => {
  const mk = (file_path: string) => ({ toolName: 'Write', input: { file_path } }) as Parameters<typeof requestPaths>[0];
  const got = requestPaths(mk('a.txt, /srv/my data, v2/gates/x'), 'linux');
  assert.ok(got.paths.includes('/srv/my data, v2/gates/x'), `the later path is rejoined: ${JSON.stringify(got.paths)}`);
  assert.ok(got.paths.includes('a.txt'));
});

test('requestPaths: a join of very many pieces is bounded (the pieces are capped and the rest is unreadable)', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `f${i}.txt`).join(', ');
  const started = Date.now();
  const got = requestPaths({ toolName: 'Write', input: { file_path: many } } as Parameters<typeof requestPaths>[0], 'linux');
  assert.ok(Date.now() - started < 1000, 'bounded work');
  assert.ok(got.unreadable, 'past the cap it fails closed');
});

test('requestPaths: a patch header is read with the white space Python counts (\\x1c to \\x1f, \\x85) as well', () => {
  const mk = (patch: string) => ({ toolName: 'Write', input: { patch } }) as Parameters<typeof requestPaths>[0];
  const got = requestPaths(mk(['*** Begin Patch', '***\u001cUpdate\u0085File:\u001fgates.json', '*** End Patch'].join('\n')), 'linux');
  assert.deepEqual(got.paths, ['gates.json']);
});

test('expandRequestPath: ~ is the home folder, a relative path is from the session folder, ~name cannot be read', () => {
  const win = process.platform === 'win32';
  const home = win ? 'C:\\Users\\me' : '/home/me';
  const cwd = win ? 'D:\\work' : '/work';
  const j = (...p: string[]) => p.join(win ? '\\' : '/');
  assert.equal(expandRequestPath('~', cwd, home), home);
  assert.equal(expandRequestPath('~/x/y.txt', cwd, home), j(home, 'x', 'y.txt'));
  assert.equal(expandRequestPath('~\\x', cwd, home), j(home, 'x'));
  assert.equal(expandRequestPath('a/b.txt', cwd, home), j(cwd, 'a', 'b.txt'));
  assert.equal(expandRequestPath('../up.txt', cwd, home), win ? 'D:\\up.txt' : '/up.txt');
  assert.equal(expandRequestPath('~other/x', cwd, home), undefined, 'another user home is not Legion to read');
});

test('hermesHomes: the default home carries HERMES_DATA_DIR_SUFFIX, from the entry or from the environment, as Hermes reads it', () => {
  const entry = (env?: Record<string, string>) => ({ id: 'hermes', label: 'Hermes', command: 'hermes', args: [], tested: true, enabled: true, ...(env ? { env } : {}) }) as Parameters<typeof hermesHomes>[0];
  const posix = hermesHomes(entry(), undefined, { HERMES_DATA_DIR_SUFFIX: '-work' }, 'linux');
  assert.ok(posix.some((h) => h.endsWith('.hermes-work')), JSON.stringify(posix));
  const fromEntry = hermesHomes(entry({ HERMES_DATA_DIR_SUFFIX: '-x' }), undefined, {}, 'linux');
  assert.ok(fromEntry.some((h) => h.endsWith('.hermes-x')), JSON.stringify(fromEntry));
  const win = hermesHomes(entry(), undefined, { HERMES_DATA_DIR_SUFFIX: '-work', LOCALAPPDATA: 'C:\L' }, 'win32');
  assert.ok(win.some((h) => h.endsWith('hermes-work')), JSON.stringify(win));
  assert.ok(hermesHomes(entry(), undefined, {}, 'linux').some((h) => h.endsWith('.hermes')), 'no suffix: the plain default');
});
