/**
 * Preflight, Mac and Linux (R-M8): a release that a 0.3.5 managed clone would apply must be code-only with a dependency hash equal to the
 * previous release's. Anything else is shown to those users as the "run the installer again" notice. Also pins the installMode check
 * (it used to import a name apply.js does not export, so it fell into its catch and never ran).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
type Verdict = { level: string; message: string };
interface Lib { unixApplyVerdict(o: { version: string; requiresFullInstall: boolean; depsSha256: string; prevDepsSha256: string | null }): Verdict; unixCloneWouldApply(v: string): boolean }
const lib = () => import(pathToFileURL(join(REPO, 'scripts', 'lib', 'unix-apply-check.mjs')).href) as Promise<Lib>;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('only releases newer than 0.3.5 are checked', async () => {
  const { unixCloneWouldApply: w } = await lib();
  assert.equal(w('0.3.5'), false);
  assert.equal(w('0.3.4'), false);
  assert.equal(w('0.3.5-b'), true);
  assert.equal(w('0.3.6'), true);
  assert.equal(w('0.4.0'), true);
  assert.equal(w('1.0.0'), true);
  assert.equal(w('0.3.10'), true);
  assert.equal(w('nonsense'), false);
});

test('code-only with an equal hash passes', async () => {
  const { unixApplyVerdict } = await lib();
  const v = unixApplyVerdict({ version: '0.3.6', requiresFullInstall: false, depsSha256: A, prevDepsSha256: A });
  assert.equal(v.level, 'pass');
});

test('a full-install release is a warning that names the installer notice, not a failure', async () => {
  const { unixApplyVerdict } = await lib();
  const v = unixApplyVerdict({ version: '0.3.6', requiresFullInstall: true, depsSha256: B, prevDepsSha256: A });
  assert.equal(v.level, 'warn');
  assert.match(v.message, /Mac and Linux users will get the "run the installer again" notice/);
});

test('requiresFullInstall false with a different hash is a failure', async () => {
  const { unixApplyVerdict } = await lib();
  const v = unixApplyVerdict({ version: '0.3.6', requiresFullInstall: false, depsSha256: B, prevDepsSha256: A });
  assert.equal(v.level, 'fail');
  assert.match(v.message, /requiresFullInstall/);
});

test('without the previous hash it warns and says how to pass it', async () => {
  const { unixApplyVerdict } = await lib();
  const v = unixApplyVerdict({ version: '0.3.6', requiresFullInstall: false, depsSha256: A, prevDepsSha256: null });
  assert.equal(v.level, 'warn');
  assert.match(v.message, /--prev-manifest/);
});

test('0.3.5 itself is skipped even when its hash differs', async () => {
  const { unixApplyVerdict } = await lib();
  assert.equal(unixApplyVerdict({ version: '0.3.5', requiresFullInstall: false, depsSha256: B, prevDepsSha256: A }).level, 'skip');
});

test('preflight wires the check in and takes the previous manifest', () => {
  const src = readFileSync(join(REPO, 'scripts', 'release-preflight.mjs'), 'utf8');
  assert.match(src, /unixApplyVerdict\(/);
  assert.match(src, /'prev-manifest'/);
  assert.match(src, /'prev-deps-sha256'/);
});

test('the installMode check imports from where installMode is exported and a failure to run it is a failure', async () => {
  const src = readFileSync(join(REPO, 'scripts', 'release-preflight.mjs'), 'utf8');
  const m = /const \{ installMode \} = await import\(new URL\(`\.\.\/dist\/src\/core\/updater\/([a-z-]+)\.js/.exec(src);
  assert.ok(m, 'the installMode import is present');
  const mod = await import(pathToFileURL(join(REPO, 'dist', 'src', 'core', 'updater', `${m![1]}.js`)).href) as Record<string, unknown>;
  assert.equal(typeof mod.installMode, 'function', `dist/src/core/updater/${m![1]}.js must export installMode`);
  assert.doesNotMatch(src, /could not determine installMode \(non-fatal\)/, 'the check must not swallow its own import error');
});
