import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository is public as it is: every tracked file is published. This guards what must never be in it.
// Walks from dist/test/, so the checkout root is two levels up wherever the suite runs.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string[] => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);

// Private names, built from fragments at runtime so this file never holds them as literals.
const VAULT = ['Aether', 'keep'].join('');
const VPS = ['rune-', 'vps'].join('');
const SURNAME = ['Hjerm', 'itslev'].join('');
const PRIVATE: Array<[string, RegExp]> = [
  ['the maintainer\'s private vault', new RegExp('\\b' + VAULT + '\\b', 'i')],
  ['a private host', new RegExp('\\b' + VPS + '\\b', 'i')],
  ['a cloud session link', /claude\.ai\/code\/session_[A-Za-z0-9]/],
  ['the maintainer\'s surname', new RegExp(SURNAME, 'i')],
];
// The copyright lines name the maintainer on purpose.
const SURNAME_OK = new Set(['LICENSE', 'NOTICE']);
const TEXT = /\.(md|txt|json|jsonl|ts|tsx|js|mjs|cjs|css|html|svg|yml|yaml|ps1|cmd|sh|tsv)$|^(LICENSE|NOTICE|\.gitignore|\.gitattributes)$/;

export function privateHits(rel: string, body: string): string[] {
  return PRIVATE.filter(([what, re]) => re.test(body) && !(what.includes('surname') && SURNAME_OK.has(rel))).map(([what]) => `${rel}: ${what}`);
}

test('no tracked file names the maintainer\'s private vault, hosts or sessions', () => {
  const files = git('ls-files').filter((f) => TEXT.test(f) && f !== 'package-lock.json');
  assert.ok(files.length > 500, `the scan sees the whole tree (${files.length} files)`);
  const hits = files.flatMap((f) => privateHits(f, readFileSync(join(REPO, f), 'utf8')));
  assert.deepEqual(hits, [], 'private details in the public repository; reword them or keep the note outside the repo');
});

test('no tracked file is one .gitignore excludes', () => {
  // `git add -f` gets past .gitignore; this is the check that catches it (four reports reached main that way in 0.3.5)
  assert.deepEqual(git('ls-files', '-ci', '--exclude-standard'), [], 'ignored files are tracked: `git rm --cached` them');
});

test('the private-name scan sees planted names, and leaves the copyright lines alone (planted)', () => {
  assert.equal(privateHits('docs/x.md', `see D:/${VAULT}/notes`).length, 1);
  assert.equal(privateHits('docs/x.md', `ssh ${VPS} uptime`).length, 1);
  assert.equal(privateHits('docs/x.md', ['https://claude.ai/code/', 'session_', '01AbCd'].join('')).length, 1);
  assert.equal(privateHits('README.md', `by Daniel ${SURNAME}`).length, 1);
  assert.equal(privateHits('LICENSE', `Copyright 2026 Daniel ${SURNAME}`).length, 0);
  assert.deepEqual(privateHits('src/a.ts', 'const keepalive = 1; // aether'), []);
});
