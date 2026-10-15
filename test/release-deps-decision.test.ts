/** release-deps-decision.mjs: CI decides from data whether a release needs the full package (never from a human flag). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const lock = (version: string, dep: string) => JSON.stringify({
  name: 'legion', version, lockfileVersion: 3,
  packages: { '': { name: 'legion', version, dependencies: { x: '^1.0.0' } }, 'node_modules/x': { version: dep } },
}, null, 2) + '\n';

function decide(prev: string | undefined, next: string): { status: number | null; out: Record<string, unknown>; stderr: string } {
  const d = tempDir('deps-dec-');
  const n = join(d, 'new.json'); writeFileSync(n, next);
  const argv = [join(REPO, 'scripts', 'release-deps-decision.mjs'), '--lock', n];
  if (prev !== undefined) { const p = join(d, 'prev.json'); writeFileSync(p, prev); argv.push('--previous-lock', p); }
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  let out: Record<string, unknown> = {};
  try { out = JSON.parse(r.stdout) as Record<string, unknown>; } catch { /* leave empty */ }
  return { status: r.status, out, stderr: r.stderr };
}

test('a version-only lock change does not need the full package', () => {
  const r = decide(lock('0.2.7', '1.0.0'), lock('0.3.0', '1.0.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.requiresFullInstall, false);
});

test('a changed dependency needs the full package', () => {
  const r = decide(lock('0.2.7', '1.0.0'), lock('0.3.0', '1.1.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.requiresFullInstall, true);
  assert.match(String(r.out.reason), /dependenc/i);
});

test('with no previous lock it fails closed: the full package is required', () => {
  const r = decide(undefined, lock('0.3.0', '1.0.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.requiresFullInstall, true);
  assert.match(String(r.out.reason), /no previous/i);
});

test('an unreadable new lock is an error, not a silent "no change"', () => {
  const r = decide(lock('0.2.7', '1.0.0'), '');
  assert.notEqual(r.status, 0);
});

function previousTag(version: string, tags: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'release-previous-tag.mjs'), '--version', version], { encoding: 'utf8', input: tags.join('\n') });
  return { status: r.status, out: r.stdout.trim() };
}

test('previous release tag: the highest release below this version, letters ranked, junk and itself ignored', () => {
  const tags = ['v0.2.5-q', 'v0.2.6', 'v0.2.7', 'v0.3.0', 'v0.10.0', 'nightly', 'v0.2.6-beta.1', 'v0.2.7-a'];
  assert.equal(previousTag('0.3.0', tags).out, 'v0.2.7');
  assert.equal(previousTag('0.10.0', tags).out, 'v0.3.0');
  assert.equal(previousTag('0.2.7', tags).out, 'v0.2.7-a');
  assert.equal(previousTag('0.2.6', tags).out, 'v0.2.5-q');
});

test('previous release tag: none found prints nothing and exits 0 (the decision then fails closed)', () => {
  const r = previousTag('0.1.0', ['v0.2.0']);
  assert.equal(r.status, 0); assert.equal(r.out, '');
});

// ---- --stone-lock: does this release still match the lock a stepping-stone (0.3.0) install holds? (docs/SHIPPING.md, Stepping stones)
function decideWithStone(prev: string, next: string, stone: string | 'missing' | 'omit'): { status: number | null; out: Record<string, unknown>; stderr: string } {
  const d = tempDir('deps-dec-stone-');
  const n = join(d, 'new.json'); writeFileSync(n, next);
  const p = join(d, 'prev.json'); writeFileSync(p, prev);
  const argv = [join(REPO, 'scripts', 'release-deps-decision.mjs'), '--lock', n, '--previous-lock', p];
  if (stone === 'missing') argv.push('--stone-lock', join(d, 'no-such-lock.json'));
  else if (stone !== 'omit') { const s = join(d, 'stone.json'); writeFileSync(s, stone); argv.push('--stone-lock', s); }
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  let out: Record<string, unknown> = {};
  try { out = JSON.parse(r.stdout) as Record<string, unknown>; } catch { /* leave empty */ }
  return { status: r.status, out, stderr: r.stderr };
}

test('stone lock: same dependency tree as the stone (only versions differ) -> carryFull false', () => {
  const r = decideWithStone(lock('0.3.1', '1.0.0'), lock('0.3.2', '1.0.0'), lock('0.3.0', '1.0.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.carryFull, false);
  assert.equal(r.out.requiresFullInstall, false);
});

test('stone lock: a tree that differs from the stone carries the full package even when it is unchanged since the previous release', () => {
  // 0.3.1 changed x; 0.3.2 did not (requiresFullInstall false) but a 0.3.0 install still holds the old x
  const r = decideWithStone(lock('0.3.1', '1.1.0'), lock('0.3.2', '1.1.0'), lock('0.3.0', '1.0.0'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.requiresFullInstall, false, 'requiresFullInstall stays computed against the previous release');
  assert.equal(r.out.carryFull, true);
  assert.match(String(r.out.stoneHash ?? ''), /^[0-9a-f]{64}$/);
});

test('stone lock: missing or unreadable stone lock fails closed (carryFull true), a garbage one too', () => {
  for (const stone of ['missing', '', 'not json']) {
    const r = decideWithStone(lock('0.3.1', '1.0.0'), lock('0.3.2', '1.0.0'), stone);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.carryFull, true, `stone=${JSON.stringify(stone)}`);
    assert.match(String(r.out.carryReason), /stone/i);
  }
});

test('stone lock: no --stone-lock at all also fails closed', () => {
  const r = decideWithStone(lock('0.3.1', '1.0.0'), lock('0.3.2', '1.0.0'), 'omit');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.carryFull, true);
});
