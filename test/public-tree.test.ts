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
const USER = ['Dan', 'ie'].join('');
const SEP = '(\\\\\\\\|\\\\|/)+'; // a path separator as it appears in text: /, \ or an escaped \\
const PRIVATE: Array<[string, RegExp]> = [
  ['the maintainer\'s private vault', new RegExp('\\b' + VAULT + '\\b', 'i')],
  ['a private host', new RegExp('\\b' + VPS + '\\b', 'i')],
  ['a cloud session link', /claude\.ai\/code\/session_[A-Za-z0-9]/],
  ['the maintainer\'s surname', new RegExp(SURNAME, 'i')],
  // tests and docs use made-up folders (D:/work/..., C:/Users/someone, <pkg-dir>); the maintainer's own ones stay out
  ['a folder on the maintainer\'s machine', new RegExp('\\b[A-Z]:' + SEP + 'bots\\b', 'i')],
  ['the maintainer\'s user folder', new RegExp('Users' + SEP + USER + '\\b|/home/' + USER.toLowerCase() + '\\b')],
];
// Maintainer material has a home outside the repo (plans, handoffs, ledgers, agent briefs and reports); PR #187 had to remove 42 such files.
const NOT_PUBLIC: Array<[string, RegExp]> = [
  ['a maintainer notes folder', /^(claude|review|docs\/superpowers)\//],
  ['an agent ledger folder', /(^|\/)\.superpowers\//],
  ['a session handoff or resume note', /(^|\/)(HANDOFF|RESUME|START-HERE|SESSION-QUEUE|ORCHESTRATOR-(HANDOFF|TAKEOVER))[^/]*\.md$/i],
  ['an agent brief, report or ledger', /(^|\/)[^/]*-(handoff|resume|brief|report|ledger|scratch)(-[^/]*)?\.md$|(^|\/)progress\.md$/i],
];
export function notPublicPath(rel: string): string[] {
  return NOT_PUBLIC.filter(([, re]) => re.test(rel)).map(([what]) => `${rel}: ${what}`);
}
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

test('no tracked file is maintainer material (plans, handoffs, ledgers, agent briefs and reports)', () => {
  assert.deepEqual(git('ls-files').flatMap(notPublicPath), [], 'keep these notes outside the public repository');
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

test('the folder and path scans see planted cases and leave made-up ones alone (planted)', () => {
  assert.equal(privateHits('docs/x.md', ['--out D:/', 'bots/legion-pkg-1'].join('')).length, 1);
  assert.equal(privateHits('test/x.ts', ["'D:", '\\\\', 'bots', '\\\\', "repo'"].join('')).length, 1, 'escaped backslashes in source');
  assert.equal(privateHits('test/x.ts', ['C:\\Users\\', USER, '\\x'].join('')).length, 1);
  assert.equal(privateHits('test/x.ts', ['rm -rf /c/Users/', USER].join('')).length, 1);
  assert.deepEqual(privateHits('test/x.ts', "'D:/work/repo' 'C:\\\\Users\\\\someone\\\\x' '/home/me/' 'C:/Users/Daniel'"), []);
  assert.deepEqual(privateHits('src/a.ts', 'const robots = 1; // chatbots'), []);
  for (const p of ['claude/plan.md', 'review/r1.md', 'docs/superpowers/plans/x.md', 'a/.superpowers/sdd/x/task-1-report.md', 'docs/HANDOFF.md', 'docs/release-brief.md', 'notes/progress.md'])
    assert.ok(notPublicPath(p).length >= 1, p);
  for (const p of ['src/core/marshal/orchestrator.ts', 'src/core/brief.ts', 'docs/design/plan-updater.md', 'docs/RELEASE-NOTES.md', 'test/ledger.test.ts', '.github/ISSUE_TEMPLATE/bug_report.yml'])
    assert.deepEqual(notPublicPath(p), [], p);
});
