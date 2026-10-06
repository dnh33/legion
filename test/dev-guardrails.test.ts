/**
 * Dev guardrails: `npm test` refuses the full suite outside CI (scripts/dev/test-guard.mjs), and `npm run tidy`
 * (scripts/dev/tidy.mjs) classifies leftovers conservatively. Pure functions only; --apply is never run here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const guard = fileURLToPath(new URL('../../scripts/dev/test-guard.mjs', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tidy: any = await import(pathToFileURL(fileURLToPath(new URL('../../scripts/dev/tidy.mjs', import.meta.url))).href);

function runGuard(env: Record<string, string | undefined>) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.CI;
  delete e.LEGION_LOCAL_GATE;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync(process.execPath, [guard], { env: e, encoding: 'utf8' });
}

test('test-guard refuses without CI or LEGION_LOCAL_GATE, with both escape forms in the message', () => {
  const r = runGuard({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs on GitHub CI/);
  assert.match(r.stderr, /LEGION_LOCAL_GATE=1 npm test/);
  assert.match(r.stderr, /\$env:LEGION_LOCAL_GATE=1; npm test/);
  assert.match(r.stderr, /node --test dist\/test\/<name>\.test\.js/);
});

test('test-guard passes with CI truthy or LEGION_LOCAL_GATE=1, refuses for CI=false/0/empty and other gate values', () => {
  assert.equal(runGuard({ CI: 'true' }).status, 0);
  assert.equal(runGuard({ CI: '1' }).status, 0);
  assert.equal(runGuard({ LEGION_LOCAL_GATE: '1' }).status, 0);
  assert.equal(runGuard({ CI: 'false' }).status, 1);
  assert.equal(runGuard({ CI: '0' }).status, 1);
  assert.equal(runGuard({ CI: '' }).status, 1);
  assert.equal(runGuard({ LEGION_LOCAL_GATE: '0' }).status, 1);
});

test('package.json runs the guard first in test and test:run, tidy is wired, and CI calls node --test directly', () => {
  const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
  assert.match(pkg.scripts.test, /^node scripts\/dev\/test-guard\.mjs && /);
  assert.match(pkg.scripts['test:run'], /^node scripts\/dev\/test-guard\.mjs && /);
  assert.equal(pkg.scripts.tidy, 'node scripts/dev/tidy.mjs');
  const ci = readFileSync(root + '.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /run: node --test /);
  assert.doesNotMatch(ci, /npm (run )?test/);
});

const FULL_WIN = '"C:\\Program Files\\nodejs\\node.exe" --test "dist\\test\\*.test.js"';
const FULL_POSIX = 'node --test --test-timeout=180000 --test-shard=1/4 dist/test/*.test.js';

test('isDevProcess flags every dev pattern', () => {
  const dev = [
    FULL_WIN,
    FULL_POSIX,
    'node --test "dist/test/*.test.js"',
    'node C:\\x\\node_modules\\serve\\build\\main.js serve -s dist',
    'node D:\\bots\\legion\\scripts\\harness\\legion-harness.mjs',
    'node ui/dev/shots-rig/build-hero.mjs',
    'node ui\\dev\\serve.mjs',
    'node D:\\bots\\legion\\node_modules\\vite\\bin\\vite.js --config ui/vite.config.ts',
    'node node_modules/vite/bin/vite.js preview',
    'node C:\\x\\node_modules\\playwright-core\\cli.js install chromium',
    'node C:\\Users\\Danie\\AppData\\Local\\Temp\\legion-abc123\\run.mjs',
    'node C:\\Users\\Danie\\AppData\\Local\\Temp\\claude\\D--bots-legion\\x\\scratchpad\\probe.mjs',
  ];
  for (const c of dev) assert.equal(tidy.isDevProcess(c), true, c);
});

test('a targeted run is NOT a full suite', () => {
  const targeted = [
    'node --test dist/test/chat.test.js',
    'node --test "dist/test/*.test.js" --test-name-pattern=foo',
    'node --test --test-name-pattern="x" "dist/test/*.test.js"',
    'node --test dist/test/harness-smoke.test.js dist/test/other.test.js',
    'node scripts/test-map/select.mjs --run',
  ];
  for (const c of targeted) assert.equal(tidy.isDevProcess(c), false, c);
  assert.equal(tidy.devPattern(FULL_WIN), 'full test suite');
});

test('vite build is not a dev server', () => {
  assert.equal(tidy.isDevProcess('node node_modules/vite/bin/vite.js build --config ui/vite.config.ts'), false);
});

test('isProtected: installed app, MCP helpers, Claude Code are never listed, even when they look like dev patterns', () => {
  const prot = [
    'C:\\Users\\Danie\\AppData\\Local\\Programs\\Legion\\Legion.exe',
    '"C:\\Users\\Danie\\AppData\\Local\\Programs\\Legion\\resources\\legion-core\\node.exe" legion-core.js',
    'node C:\\x\\npx-cli.js -y @playwright/mcp@latest',
    'node chrome-devtools-mcp --foo',
    'node server-sequential-thinking/dist/index.js',
    'node D:\\bots\\legion\\dist\\src\\bin\\legion-mcp-stdio.js',
    'C:\\Users\\Danie\\.local\\bin\\claude.exe --resume',
    'claude --dangerously-skip-permissions',
    'node C:\\x\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    'pwsh -File C:\\Users\\Danie\\.claude\\shell-snapshots\\snapshot-pwsh-1.ps1',
    // protected wins over a dev pattern
    'C:\\Users\\Danie\\AppData\\Local\\Programs\\Legion\\node.exe --test "dist/test/*.test.js"',
    'node npx-cli.js playwright install',
  ];
  for (const c of prot) {
    assert.equal(tidy.isProtected(c), true, c);
    assert.equal(tidy.isDevProcess(c), false, c);
  }
  assert.equal(tidy.isProtected(FULL_POSIX), false);
});

const wts = [
  { path: 'D:/bots/legion', isMain: true, removable: false },
  { path: 'D:/bots/legion-armory', isMain: false, removable: false },
  { path: 'D:/bots/legion-old', isMain: false, removable: true },
];
const ctx = { minAge: 60, worktrees: wts };

test('classifyProcess: age, runtime name, protection', () => {
  const p = (o: object) => ({ pid: 5, name: 'node.exe', cmdline: FULL_WIN, ageMin: 120, ...o });
  assert.equal(tidy.classifyProcess(p({}), ctx).listed, true);
  assert.equal(tidy.classifyProcess(p({ ageMin: 59 }), ctx).listed, false);
  assert.equal(tidy.classifyProcess(p({ ageMin: 60 }), ctx).listed, true);
  assert.equal(tidy.classifyProcess(p({ name: 'chrome.exe' }), ctx).listed, false);
  assert.equal(tidy.classifyProcess(p({ name: 'claude.exe', cmdline: 'claude.exe' }), ctx).listed, false);
  assert.equal(tidy.classifyProcess(p({ cmdline: 'node something-harmless.js' }), ctx).listed, false);
});

test('classifyProcess: an active worktree process is never listed, a merged clean one is, the main app stays', () => {
  const p = (cmdline: string) => ({ pid: 5, name: 'node.exe', cmdline, ageMin: 500 });
  assert.equal(tidy.classifyProcess(p('node --test D:\\bots\\legion-armory\\dist\\test\\*.test.js'), ctx).listed, false);
  assert.equal(tidy.classifyProcess(p('node D:\\bots\\legion-armory\\dist\\src\\bin\\legion-core.js'), ctx).why, 'active worktree');
  assert.equal(tidy.classifyProcess(p('node D:\\bots\\legion-old\\dist\\src\\bin\\legion-core.js'), ctx).listed, true);
  assert.equal(tidy.classifyProcess(p('node D:\\bots\\legion\\dist\\src\\bin\\legion-core.js'), ctx).listed, false);
  // a longer sibling name is not the main checkout
  assert.equal(tidy.worktreeOfCmdline('node D:\\bots\\legion-armory\\x.js', wts).path, 'D:/bots/legion-armory');
});

const PORCELAIN = [
  'worktree D:/bots/legion',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree D:/bots/legion-old',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat/old',
  '',
  'worktree D:/bots/legion-det',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  'locked',
  '',
  'worktree D:/bots/legion-gone',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/gone',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

test('parseWorktreePorcelain', () => {
  const w = tidy.parseWorktreePorcelain(PORCELAIN);
  assert.equal(w.length, 4);
  assert.equal(w[0].branch, 'main');
  assert.equal(w[1].branch, 'feat/old');
  assert.equal(w[2].detached, true);
  assert.equal(w[2].locked, true);
  assert.equal(w[3].prunable, true);
});

test('worktreeRemovability: merged AND clean only; dist, dist-ui and a node_modules link are ignored', () => {
  const [main, old, det, gone] = tidy.parseWorktreePorcelain(PORCELAIN);
  const clean = ['?? dist/', '?? dist-ui/', '?? node_modules'];
  assert.equal(tidy.worktreeRemovability(old, { merged: true, statusLines: clean }).removable, true);
  assert.equal(tidy.worktreeRemovability(old, { merged: true, statusLines: [...clean, '?? node_modules/'] }).removable, true);
  assert.equal(tidy.worktreeRemovability(old, { merged: false, statusLines: [] }).removable, false);
  const dirty = tidy.worktreeRemovability(old, { merged: true, statusLines: [' M src/a.ts', '?? notes.md', '?? dist/'] });
  assert.equal(dirty.removable, false);
  assert.equal(dirty.changed, 1);
  assert.equal(dirty.untracked, 1);
  assert.equal(tidy.worktreeRemovability(old, { merged: false, statusLines: ['A  x'] }).reason, 'not merged, dirty');
  assert.equal(tidy.worktreeRemovability(main, { isMain: true, merged: true, statusLines: [] }).removable, false);
  assert.equal(tidy.worktreeRemovability(old, { isCurrent: true, merged: true, statusLines: [] }).removable, false);
  assert.equal(tidy.worktreeRemovability({ ...old, branch: 'main' }, { merged: true, statusLines: [] }).removable, false); // a checkout of main is never removed
  assert.equal(tidy.worktreeRemovability(det, { merged: true, statusLines: [] }).removable, false);
  assert.equal(tidy.worktreeRemovability(gone, { merged: true, statusLines: [] }).removable, false);
});

test('merged means reached main through a merge: a branch still on a first-parent main commit is not merged', () => {
  const all = new Set(['m1', 'm2', 'b1']);
  const firstParent = new Set(['m1', 'm2']);
  assert.equal(tidy.isMergedSha('b1', all, firstParent), true); // second-parent commit of a merge
  assert.equal(tidy.isMergedSha('m2', all, firstParent), false); // fresh branch at a main commit (an active worktree)
  assert.equal(tidy.isMergedSha('zz', all, firstParent), false); // not in main
  assert.equal(tidy.isMergedSha('', all, firstParent), false);
});

test('deletableBranches: not main, not checked out, merged only', () => {
  const all = new Set(['m1', 'b1', 'b2']);
  const fp = new Set(['m1']);
  const refs = [{ name: 'main', sha: 'b1' }, { name: 'a', sha: 'b1' }, { name: 'co', sha: 'b2' }, { name: 'fresh', sha: 'm1' }, { name: 'new', sha: 'x' }];
  const got = tidy.deletableBranches(refs, { checkedOut: new Set(['co']), allInMain: all, firstParentOfMain: fp }).map((b: { name: string }) => b.name);
  assert.deepEqual(got, ['a']);
});
