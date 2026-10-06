/**
 * Staging the house layer for a packaged install (scripts/stage-layer.mjs, called by scripts/copy-static.mjs).
 *
 * A packaged install has the layer only under `dist/context-layer`, so whatever the staging misses is missing for every
 * user. It used to copy shipped folders one level deep, which would have dropped `skills/<group>/<name>/SKILL.md` and the
 * `references/` folders beside it.
 */
import { tempDir } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { SHIPPED_DIRS, SHIPPED_FILES, listContext } from '../src/core/house/context.js';
import { syncContext } from '../src/core/house/sync.js';

/** Repo root from the COMPILED file: `dist/test/house-stage.test.js` -> up three is the root. */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

type Stage = (o: { files: string[]; dirs: string[]; from?: string; out: string }) => { staged: number; missing: number; paths: string[] };
const loadStage = async (): Promise<Stage> => (await import(pathToFileURL(join(REPO, 'scripts', 'stage-layer.mjs')).href)).stageLayer as Stage;

/** A repository tree with nesting, a non-markdown file in every shipped folder, and folders that must not ship. */
function tree(): string {
  const root = tempDir('legion-stage-');
  const put = (rel: string, text = 'x\n'): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text, 'utf8'); };
  put('AGENTS.md', '# A\n');
  put('docs/adr/README.md');
  put('docs/adr/0001-x.md');
  put('docs/adr/notes.txt');
  put('context/glossary.md');
  put('context/facts.json', '{}');
  put('context/deep/more.md');
  put('skills/review/second-look/SKILL.md', '---\nname: second-look\ndescription: d\n---\n');
  put('skills/review/second-look/references/why.md');
  put('skills/review/second-look/scripts/run.sh', '#!/bin/sh\n');
  put('skills/review/second-look/LICENSE.md', 'MIT\n');
  put('skills/review/second-look/LICENSE-other.md', 'MIT\n');
  put('skills/review/second-look/NOTICE', 'a notice with no extension\n'); // not .md: stays out
  put('skills/SOURCES.md');
  put('claude/skills/mine.md'); // never shipped
  put('docs/video-v2/big.md'); // never shipped
  return root;
}

describe('house layer staging', () => {
  it('stages nested skill files and references, and the same files the sync would find', async () => {
    const stage = await loadStage();
    const root = tree();
    const out = join(tempDir('legion-stage-out-'), 'context-layer'); // outside the tree, so the sync below reads the tree itself
    const res = stage({ files: ['AGENTS.md'], dirs: ['docs/adr', 'context', 'skills'], from: root, out });
    const want = [
      'AGENTS.md',
      'context/deep/more.md', 'context/facts.json', 'context/glossary.md',
      'docs/adr/0001-x.md', 'docs/adr/README.md',
      'skills/SOURCES.md', 'skills/review/second-look/LICENSE-other.md', 'skills/review/second-look/LICENSE.md', 'skills/review/second-look/SKILL.md', 'skills/review/second-look/references/why.md',
    ];
    assert.deepEqual([...res.paths].sort(), want, 'staged set differs from the intended one');
    const staged = listContext(out, { all: true }).files.map((f) => f.path);
    assert.deepEqual(staged, want, 'what is on disk in the staging folder');
    // The sync walks the same shipped folders. SHIPPED_FILES is fixed, so compare only the directory part it adds.
    const data = tempDir('legion-stage-data-');
    syncContext(root, data); // source install: reads the tree itself
    const fromTree = listContext(join(data, 'context'), { all: true }).files.map((f) => f.path);
    const dirOnly = (list: string[]): string[] => list.filter((p) => SHIPPED_DIRS.some((d) => p.startsWith(`${d}/`)));
    assert.deepEqual(dirOnly(fromTree), dirOnly(staged), 'the sync and the staging disagree about what ships under the folders');
    assert.ok(!staged.some((p) => p.endsWith('.sh') || p.endsWith('/NOTICE') || p.endsWith('.txt')), 'a non-markdown file was staged');
    assert.ok(!staged.some((p) => p.startsWith('claude/') || p.includes('video-v2')), 'something that is not shipped was staged');
  });

  it('keeps the staging lists identical to SHIPPED_FILES and SHIPPED_DIRS', () => {
    const src = readFileSync(join(REPO, 'scripts', 'copy-static.mjs'), 'utf8');
    const list = (name: string): string[] => {
      const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(src);
      assert.ok(m, `${name} not found in copy-static.mjs`);
      return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    };
    assert.deepEqual(list('LAYER_FILES'), [...SHIPPED_FILES], 'copy-static LAYER_FILES drifted from SHIPPED_FILES');
    assert.deepEqual(list('LAYER_DIRS'), [...SHIPPED_DIRS], 'copy-static LAYER_DIRS drifted from SHIPPED_DIRS');
    assert.ok((SHIPPED_DIRS as readonly string[]).includes('skills'), 'skills is shipped');
  });

  it('removes a file that is no longer shipped from the staging folder', async () => {
    const stage = await loadStage();
    const root = tree();
    const out = join(root, 'dist', 'context-layer');
    stage({ files: [], dirs: ['docs/adr'], from: root, out });
    writeFileSync(join(out, 'leftover.md'), 'old\n', 'utf8');
    stage({ files: [], dirs: ['docs/adr'], from: root, out });
    assert.ok(!listContext(out, { all: true }).files.some((f) => f.path === 'leftover.md'), 'a stale file survived a re-stage');
  });

  it('stages the real skills of this repository (the built layer carries them)', () => {
    const staged = listContext(join(REPO, 'dist', 'context-layer'), { all: true }).files.map((f) => f.path);
    const skillMds = staged.filter((p) => /^skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(p));
    assert.ok(skillMds.length > 0, `no nested SKILL.md in the built layer: ${staged.filter((p) => p.startsWith('skills/')).join(', ')}`);
  });

  /** Every folder under skills/ that holds a SKILL.md, from a file list. */
  const skillFolders = (paths: string[]): string[] =>
    paths.filter((p) => /^skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.slice(0, -'SKILL.md'.length));
  const licenceMd = /^LICEN[CS]E[^/]*\.md$/i;

  it('every shipped skill folder carries a LICENSE*.md in the repository, so the licence text travels with the skill', () => {
    const inRepo = listContext(join(REPO, 'skills'), { all: true }).files.map((f) => `skills/${f.path}`);
    const folders = skillFolders(inRepo);
    assert.ok(folders.length > 0, 'no skills found in the repository');
    for (const dir of folders) {
      assert.ok(inRepo.some((p) => p.startsWith(dir) && licenceMd.test(p.slice(dir.length))), `${dir} has no LICENSE*.md (only .md files are staged and synced)`);
    }
  });

  it('and the built layer carries those licence texts to a packaged install', () => {
    const staged = listContext(join(REPO, 'dist', 'context-layer'), { all: true }).files.map((f) => f.path);
    const folders = skillFolders(staged);
    assert.ok(folders.length > 0, 'no skills in the built layer');
    for (const dir of folders) {
      assert.ok(staged.some((p) => p.startsWith(dir) && licenceMd.test(p.slice(dir.length))), `${dir} shipped without its licence text`);
    }
  });
});
