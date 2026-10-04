/**
 * release-preflight.mjs: the --pkg flag, which used to have a hardcoded owner-local default.
 *
 * Two defects lived in that one default, and the second is the one that mattered operationally:
 *
 *   1. It put a private local path into a script that ships in the public repo. Code files are deliberately
 *      not scrubbed by export-public.mjs (they must stay byte-identical), so this literal would have published.
 *   2. With no --pkg, the gate silently checked that folder and reported four FAILs reading "release artifacts
 *      missing -- run build-package.mjs first", about a folder nobody had named. The comment three lines above the
 *      artifact checks says a wrong guess must NOT read as "release artifacts missing". It did exactly that.
 *
 * So these tests pin the loud failure and the absence of the literal, not just that the script runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'release-preflight.mjs');

interface Run { code: number; stdout: string; stderr: string }
function run(...argv: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** A folder shaped like build-package.mjs's --out, so the gate gets past the flag and on with its real work. */
function artifactDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'legion-preflight-'));
  return d;
}

test('with no --pkg the gate refuses loudly and says which flag is missing', () => {
  const r = run('--version', '0.2.3-b');
  assert.notEqual(r.code, 0, 'a missing required flag must not exit 0');
  assert.match(r.stderr, /--pkg/, 'the message must name the missing flag');
  assert.match(r.stderr, /usage:/, 'and show how to call it');
  assert.match(r.stderr, /no default/i, 'and say there is deliberately no default, so nobody re-adds one');
});

test('with no --pkg it does NOT claim the release artifacts are missing', () => {
  // This is the behaviour that made the default worth removing: the real cause was a missing flag, and the gate
  // told the reader to re-run a build they had already run, about a folder they had never named.
  const r = run('--version', '0.2.3-b');
  const all = r.stdout + r.stderr;
  assert.ok(!/run build-package\.mjs first/i.test(all),
    `a missing flag must not read as missing artifacts:\n${all}`);
  assert.ok(!/artifacts missing/i.test(all), `nor as a missing-artifact failure:\n${all}`);
  assert.ok(!/RELEASE PREFLIGHT/.test(r.stdout), 'and it should refuse before printing the gate banner');
});

test('with --pkg the gate gets past the flag and runs its real checks', () => {
  const dir = artifactDir();
  try {
    const r = run('--version', '0.2.3-b', '--pkg', dir);
    assert.doesNotMatch(r.stderr, /--pkg/, 'a supplied --pkg must not be reported missing');
    assert.match(r.stdout, /RELEASE PREFLIGHT/, 'the banner runs once the flag is satisfied');
    // An empty folder legitimately fails the artifact checks. That is the gate working, not the flag failing.
    assert.match(r.stdout + r.stderr, /legion-0\.2\.3-b-app\.zip|manifest|signature/,
      'it went on to the artifact checks rather than stopping at the flag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--pkg is honoured wherever the artifacts are, not only in one hardcoded folder', () => {
  // The owner may build anywhere. Before the fix, any other folder was ignored and the hardcoded one was checked.
  const a = artifactDir();
  const b = artifactDir();
  try {
    const ra = run('--version', '0.2.3-b', '--pkg', a);
    const rb = run('--version', '0.2.3-b', '--pkg', b);
    // Plain substring checks: the gate prints the folder it was given, verbatim.
    const nameOf = (r: Run, d: string) => (r.stdout + r.stderr).includes(d);
    assert.ok(nameOf(ra, a), 'the first folder should be the one reported missing');
    assert.ok(nameOf(rb, b), 'the second folder should be the one reported missing');
    assert.ok(!nameOf(rb, a), 'and the second run must not fall back to the first');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('the script carries no owner-local path literal', () => {
  // Guards the first defect. export-public.mjs leaves code byte-identical, so a literal here is a literal in the
  // public repo. The drive-and-folder names are assembled at runtime so this assertion never depends on them.
  const DRIVE_LOCAL = ['D', ':/bots'].join('');
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(!src.includes(DRIVE_LOCAL), 'the owner-local default must not come back');
  assert.ok(!/a\.pkg\s*\?\?/.test(src), '--pkg must not have a fallback again');
  assert.ok(!existsSync(join(REPO, 'scripts', 'release-preflight.mjs.bak')), 'no stray backup');
});

test('an unknown option is still refused, so a typo cannot silently skip the flag check', () => {
  const r = run('--version', '0.2.3-b', '--pkgs', 'somewhere');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /unknown option|unexpected argument/);
});