/**
 * The house context layer: listing, reading, recall, the sync, and the refusals.
 *
 * The refusals are the point of most of these. A path from a model's output is untrusted input like any other, and
 * `../../.legion/state.json` is the attack that matters here: state.json holds the bearer token.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CONTEXT_DIRNAME, HOUSE_LIMITS, HOUSE_SERVER_NAME, listContext, readContextFile, recallContext, resolveInside,
} from '../src/core/house/context.js';
import { syncContext } from '../src/core/house/sync.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'legion-house-'));
const roots: string[] = [];
const track = (r: string): string => { roots.push(r); return r; };
after(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });

/** A small layer with the two files a real install has, plus one the owner dropped in. */
function fixture(): string {
  const root = track(scratch());
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(root, 'claude', 'skills'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), [
    '# Working on Legion',
    '',
    'Read the architecture doc first, then the doc for the area you touch.',
    '',
    '## Rules',
    '',
    '1. The admin gate is default-deny and is never weakened to make a test pass.',
    '2. The mascot art is untouchable: effects and logic only, never repaint.',
  ].join('\n'), 'utf8');
  writeFileSync(join(root, 'docs', 'adr', '0004-dependency-hash.md'),
    '# 0004 Hash dependency content, not the raw lockfile\n\nThe updater compared a hash of the raw package-lock.json, which npm rewrites on every version bump.\n', 'utf8');
  writeFileSync(join(root, 'claude', 'skills', 'kodawari.md'), '# kodawari\n\nLook at it yourself before shipping it.\n', 'utf8');
  writeFileSync(join(root, 'CONTEXT.md'), '# Glossary\n\n**Preamble**: text appended to the system prompt.\n', 'utf8');
  // Not part of the shipped set: the owner's own note, which sync must never delete.
  writeFileSync(join(root, 'my-note.md'), '# My note\n\nSomething the owner wrote by hand.\n', 'utf8');
  return root;
}

describe('house context: listing', () => {
  it('lists every file with a forward-slash path, sorted, recursively', () => {
    const { files } = listContext(fixture());
    const paths = files.map((f: { path: string }) => f.path);
    assert.deepEqual(paths, [...paths].sort(), 'not sorted');
    assert.ok(paths.includes('AGENTS.md'));
    assert.ok(paths.includes('docs/adr/0004-dependency-hash.md'));
    assert.ok(paths.includes('claude/skills/kodawari.md'));
    assert.ok(!paths.some((p: string) => p.includes('\\')), 'a path kept a backslash');
  });

  it('reports expected files that are absent, so a broken install is visible rather than silently empty', () => {
    const root = track(scratch());
    writeFileSync(join(root, 'AGENTS.md'), '# only this\n', 'utf8');
    const { missing } = listContext(root);
    assert.ok(missing.includes('CONTEXT.md'), 'CONTEXT.md should be reported missing');
    assert.ok(missing.includes('docs/adr/README.md'), 'the ADR index should be reported missing');
    assert.ok(!missing.includes('AGENTS.md'), 'AGENTS.md is present and must not be reported missing');
  });

  it('does not throw on a root that does not exist', () => {
    const gone = join(track(scratch()), 'no-such-dir');
    const { files } = listContext(gone);
    assert.deepEqual(files, []);
  });
});

describe('house context: reading', () => {
  it('reads a file and reports its path', () => {
    const root = fixture();
    const out = readContextFile(root, 'AGENTS.md');
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.text.includes('admin gate'));
    assert.ok(out.ok && out.path === 'AGENTS.md');
  });

  it('reads a nested file and accepts a backslash path from a Windows agent', () => {
    const root = fixture();
    const out = readContextFile(root, 'docs\\adr\\0004-dependency-hash.md');
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.text.includes('raw package-lock.json'));
  });

  it('refuses to escape the context root', () => {
    const root = fixture();
    for (const attempt of ['../state.json', '../../.legion/state.json', 'docs/../../state.json', '..\\state.json', 'docs/adr/../../../config.json']) {
      const out = readContextFile(root, attempt);
      assert.equal(out.ok, false, `${attempt} should have been refused`);
      assert.ok(!out.ok && out.reason === 'outside', `${attempt} gave reason ${!out.ok ? out.reason : 'n/a'}`);
    }
  });

  it('refuses an absolute path and a bare drive letter', () => {
    const root = fixture();
    assert.equal(readContextFile(root, resolve(root, '..', 'state.json')).ok, false);
    assert.equal(readContextFile(root, 'C:/Windows/win.ini').ok, false);
    assert.equal(readContextFile(root, '\\\\server\\share\\x').ok, false);
  });

  it('refuses the root itself and a NUL byte', () => {
    const root = fixture();
    assert.equal(resolveInside(root, '.'), null);
    assert.equal(resolveInside(root, ''), null);
    assert.equal(resolveInside(root, 'AGENTS.md\0.txt'), null);
  });

  it('says absent for a file that is not there, and for a folder', () => {
    const root = fixture();
    const gone = readContextFile(root, 'docs/adr/9999-nope.md');
    assert.ok(!gone.ok && gone.reason === 'absent');
    const dir = readContextFile(root, 'docs');
    assert.ok(!dir.ok && dir.reason === 'absent');
  });

  it('refuses an oversized file rather than truncating it, because half a rule reads as a whole rule', () => {
    const root = track(scratch());
    writeFileSync(join(root, 'huge.md'), 'x'.repeat(HOUSE_LIMITS.maxFileBytes + 1), 'utf8');
    const out = readContextFile(root, 'huge.md');
    assert.ok(!out.ok && out.reason === 'too-large');
  });

  it('clips a long but permitted file and says that it did', () => {
    const root = track(scratch());
    const body = 'a'.repeat(HOUSE_LIMITS.toolResultChars + 500);
    writeFileSync(join(root, 'long.md'), body, 'utf8');
    const out = readContextFile(root, 'long.md');
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.clipped, 'should have reported clipping');
    assert.equal(out.ok ? out.text.length : 0, HOUSE_LIMITS.toolResultChars);
  });
});

describe('house context: recall', () => {
  it('finds the rule by its words and names the section it sits in', () => {
    const hits = recallContext(fixture(), 'admin gate default deny');
    assert.ok(hits.length, 'expected a hit');
    assert.equal(hits[0].path, 'AGENTS.md');
    assert.equal(hits[0].title, 'Rules');
    assert.ok(hits[0].snippet.includes('admin gate'));
  });

  it('finds the ADR by its subject', () => {
    const hits = recallContext(fixture(), 'dependency hash lockfile');
    assert.ok(hits.some((h: { path: string }) => h.path === 'docs/adr/0004-dependency-hash.md'), 'ADR not found');
  });

  it('returns nothing rather than everything for a word that is not there', () => {
    assert.deepEqual(recallContext(fixture(), 'zzzznotaword'), []);
  });

  it('returns nothing for an empty or punctuation-only query', () => {
    const root = fixture();
    assert.deepEqual(recallContext(root, ''), []);
    assert.deepEqual(recallContext(root, '   '), []);
    assert.deepEqual(recallContext(root, '...'), []);
  });

  it('honours the limit', () => {
    assert.ok(recallContext(fixture(), 'the', 2).length <= 2);
  });
});

describe('house context: sync', () => {
  it('copies the shipped files and the shipped directories, and leaves the rest behind', () => {
    const repo = fixture();
    writeFileSync(join(repo, 'README.md'), '# readme, not part of the layer\n', 'utf8');
    const data = track(scratch());
    const res = syncContext(repo, data);
    assert.ok(res.written.includes('AGENTS.md'));
    assert.ok(res.written.some((p: string) => p.startsWith('docs/adr/')), 'the ADRs did not come across');
    const { files } = listContext(join(data, CONTEXT_DIRNAME));
    const paths = files.map((f: { path: string }) => f.path);
    assert.ok(paths.includes('claude/skills/kodawari.md'));
    assert.ok(!paths.includes('README.md'), 'README.md is not part of the layer and should not ship');
    assert.ok(!paths.includes('my-note.md'), 'a note in the repo root is not part of the layer');
  });

  it('is idempotent: a second sync copies nothing new and deletes nothing', () => {
    const repo = fixture();
    const data = track(scratch());
    const res0 = syncContext(repo, data);
    const before = listContext(join(data, CONTEXT_DIRNAME)).files.length;
    const second = syncContext(repo, data);
    assert.equal(second.written.length, 0, 'second sync rewrote files');
    assert.equal(second.unchanged.length, res0.written.length, 'the unchanged set should name every copied file');
    assert.equal(listContext(join(data, CONTEXT_DIRNAME)).files.length, before);
  });

  it('never deletes a note the owner dropped into the context folder', () => {
    const repo = fixture();
    const data = track(scratch());
    syncContext(repo, data);
    const mine = join(data, CONTEXT_DIRNAME, 'my-own-note.md');
    writeFileSync(mine, '# mine\n', 'utf8');
    syncContext(repo, data);
    assert.ok(listContext(join(data, CONTEXT_DIRNAME)).files.some((f) => f.path === 'my-own-note.md'),
      'the owner\'s note was destroyed by a sync');
  });

  it('keeps a newer local copy rather than overwriting it with an older repo file', async () => {
    const repo = fixture();
    const data = track(scratch());
    syncContext(repo, data);
    const target = join(data, CONTEXT_DIRNAME, 'AGENTS.md');
    const { utimesSync, readFileSync } = await import('node:fs');
    const local = '# locally edited rules\n\nDo not clobber me.\n';
    writeFileSync(target, local, 'utf8');
    utimesSync(target, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const res = syncContext(repo, data);
    assert.ok(res.keptNewer.includes('AGENTS.md'), 'should have kept the newer local copy');
    assert.equal(readFileSync(target, 'utf8'), local);
  });

  it('does nothing when the install root does not exist, rather than throwing at start', () => {
    const data = track(scratch());
    const res = syncContext(join(data, 'no-such-install'), data);
    assert.deepEqual(res.written, []);
    assert.deepEqual(listContext(join(data, CONTEXT_DIRNAME)).files, []);
  });

  it('skips a non-file where a file was expected', () => {
    const repo = track(scratch());
    mkdirSync(join(repo, 'docs'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'adr'), { recursive: true }); // AGENTS.md is a directory here
    const data = track(scratch());
    const res = syncContext(repo, data);
    assert.ok(res.skipped.includes('AGENTS.md'));
  });
});

describe('house context: shape', () => {
  it('names the server legion_house', () => {
    assert.equal(HOUSE_SERVER_NAME, 'legion_house');
  });

  it('keeps its read cap below the tool-result cap of the modules around it', () => {
    assert.ok(HOUSE_LIMITS.maxFileBytes > HOUSE_LIMITS.toolResultChars);
    assert.ok(HOUSE_LIMITS.recallEntries >= 1 && HOUSE_LIMITS.recallEntries <= 20);
  });
});

describe('house context: the failure this exists to prevent', () => {
  it('AGENTS.md is in the shipped set, so a missing index is reported rather than silently absent', () => {
    const { files, missing } = listContext(fixture());
    const shipped = files.map((f: { path: string }) => f.path);
    assert.ok(shipped.includes('AGENTS.md'));
    assert.ok(!missing.includes('AGENTS.md'));
  });

  it('resolves inside a Windows root without an MSYS path conversion', () => {
    // The repo runs its gates through a bash that would turn /d/... into a Windows path; resolveInside must not.
    const root = join(track(scratch()), 'context');
    mkdirSync(root, { recursive: true });
    assert.equal(resolveInside(root, 'AGENTS.md'), join(root, 'AGENTS.md'));
    assert.ok(!resolveInside(root, 'AGENTS.md')!.includes('/d/'));
    assert.ok(resolveInside(root, 'a/b.md')!.includes(sep));
  });
});