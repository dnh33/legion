/**
 * Residue must be pruned. Edited files must not be.
 *
 * ## What this exists for
 *
 * The sync's own header says "the copy is one-way and never deletes", which was right about the OWNER's files and
 * wrong about the app's. Measured on the owner's machine after several upgrades: **28 folders and 46 files** from a
 * release that predated the decision not to ship personal skills were still in the layer, still listed by `house_list`,
 * and still marked `shipped` — so served to every agent as the app's own words, unwrapped, indefinitely. Nothing
 * removed them, because nothing ever had.
 *
 * That is not neutral. The layer is the rules an agent obeys; stale rules from three releases ago are rules with no
 * owner and no expiry.
 *
 * ## The safety property, which is the whole design
 *
 * A file is removed only when all three hold:
 *   1. this build no longer ships it,
 *   2. the app shipped it at some point (it is in the manifest, so it is ours and not the owner's),
 *   3. **its bytes are still exactly what the app shipped** — `isShipped` is true.
 *
 * (3) is what makes this safe. If the bytes differ, then the owner or an agent wrote them, and the file is *work*, not
 * residue. So the only files this can ever delete are ones nobody could have edited, because nobody ever did. A test
 * that does not prove that is a test that has not earned its delete.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { syncContext } from '../src/core/house/sync.js';
import { readManifest, writeManifest } from '../src/core/house/trust.js';

const scratch = (): string => cleanupTemp('legion-prune-');
const roots: string[] = [];
const track = (r: string): string => { roots.push(r); return r; };
after(() => { for (const r of roots) { try { require('node:fs').rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * A data directory that looks like one upgraded from a release which shipped personal skills: `claude/skills/**` was
 * copied then, recorded in the manifest, and is not shipped now.
 */
function residueFixture(): { data: string; layer: string } {
  const data = track(scratch());
  const layer = join(data, 'context');
  mkdirSync(join(layer, 'claude', 'skills', 'anti-slop'), { recursive: true });
  mkdirSync(join(layer, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(layer, 'AGENTS.md'), '# Working on Legion\n\nRule 1.\n', 'utf8');
  writeFileSync(join(layer, 'claude', 'skills', 'anti-slop', 'SKILL.md'), '# Anti-slop\n\nold workflow\n', 'utf8');
  writeFileSync(join(layer, 'docs', 'adr', '0004-dependency-hash.md'), '# 0004\n', 'utf8');
  // the manifest an older release wrote: both files, with their then-current bytes
  writeManifest(layer, {
    'AGENTS.md': sha('# Working on Legion\n\nRule 1.\n'),
    'claude/skills/anti-slop/SKILL.md': sha('# Anti-slop\n\nold workflow\n'),
    'docs/adr/0004-dependency-hash.md': sha('# 0004\n'),
  });
  return { data, layer };
}

/** A source tree that ships AGENTS.md and the ADR, and no claude/skills at all — the current decision. */
function sourceTree(): string {
  const src = track(scratch());
  mkdirSync(join(src, 'dist', 'context-layer', 'docs', 'adr'), { recursive: true });
  writeFileSync(join(src, 'dist', 'context-layer', 'AGENTS.md'), '# Working on Legion\n\nRule 1.\n', 'utf8');
  writeFileSync(join(src, 'dist', 'context-layer', 'docs', 'adr', '0004-dependency-hash.md'), '# 0004\n', 'utf8');
  return src;
}

describe('residue from a release that no longer ships a file is removed', () => {
  it('removes an untouched file this build no longer ships', () => {
    const { data, layer } = residueFixture();
    const stale = join(layer, 'claude', 'skills', 'anti-slop', 'SKILL.md');
    assert.ok(existsSync(stale), 'precondition: the stale file is there');

    const res = syncContext(sourceTree(), data);

    assert.ok(!existsSync(stale), 'the stale file survived the sync');
    assert.ok(res.removed.includes('claude/skills/anti-slop/SKILL.md'), `removed was ${JSON.stringify(res.removed)}`);
  });

  it('keeps everything this build still ships', () => {
    const { data, layer } = residueFixture();
    syncContext(sourceTree(), data);
    assert.ok(existsSync(join(layer, 'AGENTS.md')), 'AGENTS.md is shipped and must survive');
    assert.ok(existsSync(join(layer, 'docs', 'adr', '0004-dependency-hash.md')), 'the ADR is shipped and must survive');
  });

  it('drops the manifest entry too, so it cannot look shipped to a reader', () => {
    const { data, layer } = residueFixture();
    syncContext(sourceTree(), data);
    assert.equal(readManifest(layer)['claude/skills/anti-slop/SKILL.md'], undefined,
      'the entry outlived the file, which is the exact state that made residue look trusted');
  });

  it('removes the emptied folders, not just the files', () => {
    // An empty claude/skills tree left behind still shows in a listing and still costs nothing but confusion.
    const { data, layer } = residueFixture();
    syncContext(sourceTree(), data);
    assert.ok(!existsSync(join(layer, 'claude')), 'the emptied claude/ folder survived');
  });

  it('is idempotent: a second sync removes nothing more', () => {
    const { data } = residueFixture();
    syncContext(sourceTree(), data);
    const second = syncContext(sourceTree(), data);
    assert.deepEqual(second.removed, [], 'the second sync removed something that was already gone');
  });
});

describe('the prune never deletes work', () => {
  it('keeps a stale file the OWNER edited', () => {
    // The safety property. Bytes differ from what the app shipped, so this is the owner's writing and it stays.
    const { data, layer } = residueFixture();
    const edited = join(layer, 'claude', 'skills', 'anti-slop', 'SKILL.md');
    writeFileSync(edited, '# Anti-slop\n\nMY OWN VERSION, do not delete\n', 'utf8');

    const res = syncContext(sourceTree(), data);

    assert.ok(existsSync(edited), 'the owner edited this file and the sync deleted it');
    assert.ok(!res.removed.includes('claude/skills/anti-slop/SKILL.md'), 'an edited file was reported as removed');
  });

  it('keeps a note the owner dropped in that the app never shipped', () => {
    // Never in the manifest, so never a candidate - this is the original promise of the sync.
    const { data, layer } = residueFixture();
    const own = join(layer, 'MY-NOTE.md');
    writeFileSync(own, '# Mine\n\nhand written\n', 'utf8');

    syncContext(sourceTree(), data);

    assert.ok(existsSync(own), 'a note the owner wrote by hand was deleted');
  });

  it('leaves an edited file untrusted rather than quietly restoring it', () => {
    const { data, layer } = residueFixture();
    const edited = join(layer, 'claude', 'skills', 'anti-slop', 'SKILL.md');
    writeFileSync(edited, '# Anti-slop\n\nedited\n', 'utf8');

    syncContext(sourceTree(), data);

    // It survives, and it survives as UNTRUSTED — the owner's bytes are not the app's words. The entry must NOT be
    // re-pointed at the edited bytes: an entry matching what is on disk is precisely what makes a file read as
    // shipped, so "harmless" bookkeeping here would hand the owner's edit the app's trust.
    const body = readFileSync(edited, 'utf8');
    assert.match(body, /edited/, 'the edited content was replaced');
    const entry = readManifest(layer)['claude/skills/anti-slop/SKILL.md'];
    assert.notEqual(entry, sha('# Anti-slop\n\nedited\n'),
      'the entry now matches the edited bytes, so the owner edit would read as shipped');
    assert.equal(entry, sha('# Anti-slop\n\nold workflow\n'),
      'the entry moved off the bytes the app actually shipped');
  });
});
