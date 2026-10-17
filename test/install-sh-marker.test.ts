/**
 * install.sh, managed-install side (R-M4): the dirty-tree rule, .git/info/exclude, the live-update refusal, the stale-update clean-up
 * and the .legion-install.json marker. The functions are cut out of the script and run in a POSIX shell against throwaway git repos;
 * the last test runs the whole script against a local bare repo with a stub npm. github.com is never contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './ps-helpers.js';
import { CODE_SET } from '../src/core/updater/apply.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installSh = join(root, 'scripts', 'install', 'install.sh');
const sh = readFileSync(installSh, 'utf8');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const skipSh = hasSh ? false : 'no sh on this machine';
const px = (p: string): string => (process.platform === 'win32' ? spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout.trim() : p);
const fn = (name: string): string => {
  const m = sh.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm'));
  assert.ok(m, `${name} is defined at the top level of install.sh`);
  return m[0];
};
const STUBS = 'say() { printf "%s\\n" "$*"; }\nfail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }\n';
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', [...ID, ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
/** Runs `body` in sh with the named install.sh functions defined; args are $1.. */
const run = (names: string[], body: string, args: string[] = [], cwd?: string) =>
  spawnSync('sh', ['-c', `${STUBS}${names.map(fn).join('\n')}\n${body}`, 'sh', ...args], { encoding: 'utf8', cwd });

function repo(files: Record<string, string>): { dir: string; p: string } {
  const dir = tempDir('install-marker-');
  git(dir, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); }
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  return { dir, p: px(dir) };
}
const BASE = { 'src/a.ts': 'a', 'ui/b.tsx': 'b', 'scripts/x.mjs': 'x', 'package.json': '{}', 'README.md': 'r', 'dir with space/f.txt': 'f', 'dist/old.js': 'o' };

// ---------------------------------------------------------------- the dirty rule
const outside = (p: string, managed: string): string => {
  const r = run(['outside_dirt'], 'git -C "$1" status --porcelain -z | outside_dirt "$2"', [p, managed]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('dirty rule: only CODE_SET paths, .update, build-info.json and the marker may be dirty', { skip: skipSh }, () => {
  const { dir, p } = repo(BASE);
  assert.equal(outside(p, '1'), '', 'clean');
  writeFileSync(join(dir, 'scripts/x.mjs'), 'changed by a swap');
  writeFileSync(join(dir, 'package.json'), '{"v":2}');
  writeFileSync(join(dir, 'README.md'), 'new');
  mkdirSync(join(dir, '.update/prev'), { recursive: true }); writeFileSync(join(dir, '.update/prev/f'), '1');
  writeFileSync(join(dir, 'build-info.json'), '{}');
  writeFileSync(join(dir, '.legion-install.json'), '{}');
  writeFileSync(join(dir, 'scripts/new-file.mjs'), 'untracked inside scripts');
  assert.equal(outside(p, '1'), '', 'updater territory is allowed');
  // the same dirt in an unmarked tree is refused
  assert.notEqual(outside(p, '0'), '', 'without a marker any change refuses');
});

test('dirty rule: src/, ui/, other tracked files and other untracked files still refuse', { skip: skipSh }, () => {
  for (const [rel, body, expect] of [
    ['src/a.ts', 'edited', 'src/a.ts'],
    ['ui/b.tsx', 'edited', 'ui/b.tsx'],
    ['dir with space/f.txt', 'edited', 'dir with space/f.txt'],
    ['notes.txt', 'untracked', 'notes.txt'],
    ['src/brand-new.ts', 'untracked in src', 'src/'],
    ['.update-not/x', 'name only starts like .update', '.update-not/'],
    ['distx/x', 'name only starts like dist', 'distx/'],
  ] as const) {
    const { dir, p } = repo(BASE);
    mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body);
    writeFileSync(join(dir, 'package.json'), '{"allowed":1}'); // allowed dirt next to it must not hide it
    assert.match(outside(p, '1'), new RegExp(`^${expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), rel);
  }
});

test('dirty rule: a rename or delete is judged by BOTH paths', { skip: skipSh }, () => {
  let { dir, p } = repo(BASE);
  git(dir, 'mv', 'src/a.ts', 'scripts/a.ts'); // into an allowed place, out of src/
  assert.match(outside(p, '1'), /src\/a\.ts/, 'the old path is in src/');
  ({ dir, p } = repo(BASE));
  git(dir, 'mv', 'scripts/x.mjs', 'src/x.mjs'); // out of an allowed place, into src/
  assert.match(outside(p, '1'), /src\/x\.mjs/);
  ({ dir, p } = repo(BASE));
  git(dir, 'mv', 'scripts/x.mjs', 'scripts/y.mjs');
  assert.equal(outside(p, '1'), '', 'both inside the allowed set');
  ({ dir, p } = repo(BASE));
  rmSync(join(dir, 'src/a.ts'));
  assert.match(outside(p, '1'), /src\/a\.ts/, 'a deleted file counts');
  ({ dir, p } = repo(BASE));
  rmSync(join(dir, 'dist'), { recursive: true });
  assert.equal(outside(p, '1'), '', 'a deleted allowed file does not');
});

// ---------------------------------------------------------------- exclude
test('exclude: the three names are written once, also when the file has no final line break', { skip: skipSh }, () => {
  const { dir, p } = repo(BASE);
  const ex = join(dir, '.git', 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  writeFileSync(ex, '# mine\n*.swp'); // no trailing newline
  for (let i = 0; i < 3; i++) { const r = run(['add_excludes'], 'add_excludes "$1"', [p]); assert.equal(r.status, 0, r.stderr); }
  const lines = readFileSync(ex, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines, ['# mine', '*.swp', '/.update/', '/build-info.json', '/.legion-install.json']);
  writeFileSync(join(dir, 'build-info.json'), '{}'); mkdirSync(join(dir, '.update')); writeFileSync(join(dir, '.update/j'), '1'); writeFileSync(join(dir, '.legion-install.json'), '{}');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'git no longer lists them');
  // an absent info folder is created
  const fresh = repo(BASE); rmSync(join(fresh.dir, '.git', 'info'), { recursive: true, force: true });
  assert.equal(run(['add_excludes'], 'add_excludes "$1"', [fresh.p]).status, 0);
  assert.match(readFileSync(join(fresh.dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.update\/$/m);
});

// ---------------------------------------------------------------- a live update
function liveMarker(dir: string, over: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, '.update'), { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, '.update', 'update-in-progress.json'), JSON.stringify({ pid: 2 ** 22 + 1234567, startTimeMs: now, fromVersion: '1', toVersion: '2', startedAt: now, heartbeat: now, ...over }));
}
const live = (p: string): boolean => run(['update_in_progress'], 'update_in_progress "$1"', [p]).status === 0;

test('live update: a fresh lease, or a lapsed lease with a living owner, blocks; no file, old, dead or garbage does not', { skip: skipSh }, () => {
  const { dir, p } = repo(BASE);
  assert.equal(live(p), false, 'no file');
  liveMarker(dir); assert.equal(live(p), true, 'fresh heartbeat');
  liveMarker(dir, { heartbeat: Date.now() - 5 * 60_000, startedAt: Date.now() - 6 * 60_000 }); assert.equal(live(p), false, 'lapsed and the owner is gone');
  liveMarker(dir, { heartbeat: Date.now() - 5 * 60_000, startedAt: Date.now() - 6 * 60_000, pid: process.pid }); assert.equal(live(p), true, 'lapsed but the owner is alive');
  liveMarker(dir, { startedAt: Date.now() - 30 * 60_000, pid: process.pid }); assert.equal(live(p), false, 'older than 20 minutes never blocks');
  writeFileSync(join(dir, '.update', 'update-in-progress.json'), 'not json'); assert.equal(live(p), false, 'garbage');
});

// ---------------------------------------------------------------- stale update clean-up
test('clean-up: journal, prev, failed and build-info.json go; outcome.json, other .update content and data stay', { skip: skipSh }, () => {
  const { dir, p } = repo(BASE);
  const u = join(dir, '.update');
  for (const d of ['prev', 'failed', 'staging']) { mkdirSync(join(u, d), { recursive: true }); writeFileSync(join(u, d, 'f'), '1'); }
  writeFileSync(join(u, 'journal.json'), '{}'); writeFileSync(join(u, 'outcome.json'), '{}'); writeFileSync(join(dir, 'build-info.json'), '{}');
  const r = run(['clear_stale_update'], 'clear_stale_update "$1"', [p]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(u).sort(), ['outcome.json', 'staging']);
  assert.equal(existsSync(join(dir, 'build-info.json')), false);
  assert.equal(run(['clear_stale_update'], 'clear_stale_update "$1"', [p]).status, 0, 'idempotent');
});

// ---------------------------------------------------------------- the marker
test('marker: the contract written exactly; head is the commit (also for an annotated tag); a branch HEAD is refused', { skip: skipSh }, () => {
  const { dir, p } = repo(BASE);
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'release');
  const tagObj = git(dir, 'rev-parse', 'v1.0.0'); const commit = git(dir, 'rev-parse', 'v1.0.0^{commit}');
  assert.notEqual(tagObj, commit);
  git(dir, 'checkout', '-q', 'tags/v1.0.0'); // detached
  const r = run(['write_marker'], 'write_marker "$1"', [p]);
  assert.equal(r.status, 0, r.stderr);
  const raw = readFileSync(join(dir, '.legion-install.json'), 'utf8');
  const m = JSON.parse(raw);
  assert.deepEqual(Object.keys(m), ['schema', 'manager', 'dir', 'head']);
  assert.equal(m.schema, 1); assert.equal(m.manager, 'install.sh'); assert.equal(m.head, commit);
  assert.match(m.head, /^[0-9a-f]{40}$/);
  const real = spawnSync('sh', ['-c', 'cd "$1" && pwd -P', 'sh', p], { encoding: 'utf8' }).stdout.trim();
  const want = process.platform === 'win32' ? spawnSync('cygpath', ['-m', real], { encoding: 'utf8' }).stdout.trim() : real;
  assert.ok(m.dir === real || m.dir === want, `dir ${m.dir} is the pwd -P path ${real}`);
  assert.equal(readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim(), commit, '.git/HEAD is the bare commit sha');
  assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0, 'no temp file left');
  // a rewrite after a new commit carries the new head
  git(dir, 'checkout', '-q', '--detach'); writeFileSync(join(dir, 'z'), 'z'); git(dir, 'add', 'z'); git(dir, 'commit', '-q', '-m', 'two');
  assert.equal(run(['write_marker'], 'write_marker "$1"', [p]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, '.legion-install.json'), 'utf8')).head, git(dir, 'rev-parse', 'HEAD'));
  // on a branch the marker is not written (the updater would call this clone a plain checkout) and an old marker is removed
  git(dir, 'checkout', '-q', '-b', 'work');
  const bad = run(['write_marker'], 'write_marker "$1"; echo "rc=$?"', [p]);
  assert.match(bad.stdout, /rc=1/, 'it reports failure to the caller instead of ending the script');
  assert.match(bad.stderr, /Legion is installed, but it could not mark this folder for self-update; updates will show a notice instead\./);
  assert.match(bad.stderr, /not a commit sha/);
  assert.equal(existsSync(join(dir, '.legion-install.json')), false, 'no stale marker is left behind');
});

test('marker: a folder name with quotes, backslashes and spaces is written as valid JSON', { skip: skipSh }, () => {
  const base = tempDir('install-marker-q-');
  const weird = join(base, process.platform === 'win32' ? `a b c (d)` : `a "b" \\c 'd`);
  mkdirSync(weird); git(weird, 'init', '-q'); writeFileSync(join(weird, 'f'), '1'); git(weird, 'add', 'f'); git(weird, 'commit', '-q', '-m', 'x');
  git(weird, 'checkout', '-q', '--detach');
  const r = run(['write_marker'], 'write_marker "$1"', [px(weird)]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(readFileSync(join(weird, '.legion-install.json'), 'utf8'));
  assert.match(m.dir, /a .*c/);
});

// ---------------------------------------------------------------- the whole script, local bare repo, stub npm
const e2eSkip = skipSh || false;

test('install.sh end to end: fresh install writes the marker; a re-run after a swap succeeds and cleans up; src/ edits and a live update refuse', { skip: e2eSkip }, () => {
  const w = tempDir('install-e2e-'); const wp = px(w);
  // the "release": a work repo pushed to a bare repo at <base>/dnh33/legion.git, with tag v0.99.0
  const bare = join(w, 'base', 'dnh33', 'legion.git'); mkdirSync(dirname(bare), { recursive: true });
  git(w, 'init', '-q', '--bare', bare);
  const src = join(w, 'src-repo'); mkdirSync(src); git(src, 'init', '-q');
  for (const [rel, body] of Object.entries({ '.gitignore': 'node_modules\ndist\ndist-ui\n', 'package.json': '{"version":"0.99.0"}', 'src/a.ts': 'a', 'scripts/x.mjs': 'x', 'README.md': 'r' })) { mkdirSync(dirname(join(src, rel)), { recursive: true }); writeFileSync(join(src, rel), body); }
  git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'v0.99.0'); git(src, 'tag', '-a', 'v0.99.0', '-m', 'v0.99.0');
  git(src, 'remote', 'add', 'origin', bare); git(src, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'v0.99.0');
  // stub npm: ci makes a fake electron, run build makes the build output
  const bin = join(w, 'bin'); mkdirSync(bin);
  const npm = join(bin, 'npm');
  writeFileSync(npm, `#!/bin/sh
case "$1" in
  ci) mkdir -p node_modules/electron && printf 'module.exports = __dirname + "/electron-bin";\\n' > node_modules/electron/index.js && printf '#!/bin/sh\\n' > node_modules/electron/electron-bin && chmod 755 node_modules/electron/electron-bin ;;
  run) mkdir -p dist/src/electron dist-ui && : > dist/src/electron/main.js && : > dist-ui/index.html ;;
esac
`); chmodSync(npm, 0o755);
  const home = join(w, 'home'); mkdirSync(home);
  const inst = `${wp}/inst`;
  const env = { ...process.env, HOME: px(home), PATH: `${px(bin)}:${process.env.PATH}`, LEGION_INSTALL_BASE: `file://${wp}/base` };
  const install = () => spawnSync('sh', [px(installSh), '--no-launch', '--dir', inst, '--version', '0.99.0'], { encoding: 'utf8', env });

  let r = install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = join(w, 'inst');
  let m = JSON.parse(readFileSync(join(dir, '.legion-install.json'), 'utf8'));
  assert.equal(m.head, git(dir, 'rev-parse', 'HEAD')); assert.equal(m.schema, 1);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'git status is empty after a fresh install');
  assert.match(readFileSync(join(dir, '.git/info/exclude'), 'utf8'), /^\/\.legion-install\.json$/m);

  // a code swap by the updater leaves the tree dirty in updater territory, and a stale journal behind
  writeFileSync(join(dir, 'scripts/x.mjs'), 'swapped'); writeFileSync(join(dir, 'README.md'), 'swapped');
  writeFileSync(join(dir, 'build-info.json'), '{"publishedAt":"2099-01-01"}');
  mkdirSync(join(dir, '.update/prev'), { recursive: true }); writeFileSync(join(dir, '.update/journal.json'), '{"state":"awaiting-health"}');
  mkdirSync(join(dir, '.update/failed'), { recursive: true });
  r = install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(dir, 'scripts/x.mjs'), 'utf8'), 'x', 'the checkout put the tag back');
  assert.equal(existsSync(join(dir, '.update/journal.json')), false);
  assert.equal(existsSync(join(dir, '.update/prev')), false);
  assert.equal(existsSync(join(dir, '.update/failed')), false);
  assert.equal(existsSync(join(dir, 'build-info.json')), false);
  m = JSON.parse(readFileSync(join(dir, '.legion-install.json'), 'utf8'));
  assert.equal(m.head, git(dir, 'rev-parse', 'HEAD'));

  // an edit in src/ refuses and is kept
  writeFileSync(join(dir, 'src/a.ts'), 'my work');
  r = install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has local changes/);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'my work');
  git(dir, 'checkout', '-q', 'src/a.ts');

  // a live update refuses and node_modules is untouched
  liveMarker(dir);
  writeFileSync(join(dir, 'node_modules', 'keep'), '1');
  r = install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /update is in progress/);
  assert.equal(existsSync(join(dir, 'node_modules', 'keep')), true);
  rmSync(join(dir, '.update/update-in-progress.json'));

  // no marker (a clone from an older installer) and a changed tracked file in updater territory: strict, as before
  rmSync(join(dir, '.legion-install.json'));
  writeFileSync(join(dir, 'scripts/x.mjs'), 'edited');
  r = install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has local changes/);
});

// ---------------------------------------------------------------- the allow-list (I4)
/** Names the installer's dirty rule has allowed so far. It only grows: a Legion that is already installed keeps swapping with ITS code set,
 *  so the installer must still allow every name any shipped CODE_SET had (a missing name makes a re-run refuse with "has local changes"). */
const PINNED_ALLOW = ['.update', '.legion-install.json', 'dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'build-info.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd'];
const installerAllowList = (): string[] => {
  const m = /split\("([^"]+)", names, " "\)/.exec(sh);
  assert.ok(m, 'outside_dirt in install.sh still has its split("...", names, " ") list');
  return m[1].split(' ');
};

test('allow-list: install.sh allows exactly CODE_SET plus .update and .legion-install.json, read from the real files', () => {
  const want = [...CODE_SET, '.update', '.legion-install.json'].sort();
  assert.deepEqual([...installerAllowList()].sort(), want, 'install.sh outside_dirt and CODE_SET (src/core/updater/apply.ts) must list the same names. Adding a name: add it in both places.');
});

test('allow-list: never shrinks (a removal strands every install that still swaps that name)', () => {
  const have = new Set(installerAllowList());
  const gone = PINNED_ALLOW.filter((n) => !have.has(n));
  assert.deepEqual(gone, [], `install.sh outside_dirt no longer allows ${gone.join(', ')}. An installed Legion keeps swapping these names with its own CODE_SET, so a re-run of the installer would refuse with "has local changes" and the person could not get a dependency release. Never remove a name from the list; if CODE_SET really drops one, keep it here.`);
  const extra = [...have].filter((n) => !PINNED_ALLOW.includes(n));
  assert.deepEqual(extra, [], `install.sh allows ${extra.join(', ')}, which is not in PINNED_ALLOW in this test. Add it there in the same commit.`);
});

// ---------------------------------------------------------------- a running Legion (I1)
const fakePs = (dir: string, lines: string[] | 'fail'): string => {
  const bin = join(dir, 'psbin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ps'), lines === 'fail' ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat <<'END_OF_PS'\n${lines.join('\n')}\nEND_OF_PS\n`);
  chmodSync(join(bin, 'ps'), 0o755);
  return px(bin);
};
const running = (psDir: string, p: string): boolean => {
  const r = spawnSync('sh', ['-c', `${STUBS}${fn('legion_running')}\nlegion_running "$1"`, 'sh', p], { encoding: 'utf8', env: { ...process.env, PATH: `${psDir}:${process.env.PATH}` } });
  return r.status === 0;
};

test('running Legion: a process with the folder\'s Electron on its command line counts; another folder, a longer name, a missing or failing ps do not', { skip: skipSh }, () => {
  const w = tempDir('install-ps-');
  const d = '/home/u/.local/share/legion';
  assert.equal(running(fakePs(w, ['/sbin/init', `${d}/node_modules/electron/dist/electron ${d}`]), d), true, 'Linux app process');
  assert.equal(running(fakePs(w, [`${d}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${d}`]), d), true, 'macOS app process');
  assert.equal(running(fakePs(w, [`node ${d}/node_modules/electron/dist/electron --type=zygote`]), d), true, 'as an argument after a space');
  assert.equal(running(fakePs(w, [`${d}2/node_modules/electron/dist/electron ${d}2`]), d), false, 'a sibling folder with a longer name');
  assert.equal(running(fakePs(w, [`/other${d}/node_modules/electron/dist/electron`]), d), false, 'the same path under another prefix');
  assert.equal(running(fakePs(w, [`sh install.sh --dir ${d}`]), d), false, 'the installer itself');
  assert.equal(running(fakePs(w, 'fail'), d), false, 'ps fails: not detected, the install goes on');
});

// ---------------------------------------------------------------- the whole script again: reftable, a marker that cannot be written, a running Legion
interface Rig { w: string; wp: string; env: NodeJS.ProcessEnv; inst: string; install: () => ReturnType<typeof spawnSync> }
function rig(name: string, extraEnv: Record<string, string> = {}): Rig {
  const w = tempDir(name); const wp = px(w);
  const bare = join(w, 'base', 'dnh33', 'legion.git'); mkdirSync(dirname(bare), { recursive: true });
  git(w, 'init', '-q', '--bare', bare);
  const src = join(w, 'src-repo'); mkdirSync(src); git(src, 'init', '-q');
  for (const [rel, body] of Object.entries({ '.gitignore': 'node_modules\ndist\ndist-ui\n', 'package.json': '{"version":"0.99.0"}', 'src/a.ts': 'a' })) { mkdirSync(dirname(join(src, rel)), { recursive: true }); writeFileSync(join(src, rel), body); }
  git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'v0.99.0'); git(src, 'tag', '-a', 'v0.99.0', '-m', 'v0.99.0');
  git(src, 'remote', 'add', 'origin', bare); git(src, 'push', '-q', 'origin', 'HEAD:refs/heads/main', 'v0.99.0');
  const bin = join(w, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh
case "$1" in
  ci) mkdir -p node_modules/electron && printf 'module.exports = __dirname + "/electron-bin";\\n' > node_modules/electron/index.js && printf '#!/bin/sh\\n' > node_modules/electron/electron-bin && chmod 755 node_modules/electron/electron-bin ;;
  run) mkdir -p dist/src/electron dist-ui && : > dist/src/electron/main.js && : > dist-ui/index.html ;;
esac
`); chmodSync(join(bin, 'npm'), 0o755);
  const home = join(w, 'home'); mkdirSync(home);
  const env = { ...process.env, HOME: px(home), PATH: `${px(bin)}:${process.env.PATH}`, LEGION_INSTALL_BASE: `file://${wp}/base`, ...extraEnv };
  const inst = `${wp}/inst`;
  return { w, wp, env, inst, install: () => spawnSync('sh', [px(installSh), '--no-launch', '--dir', inst, '--version', '0.99.0'], { encoding: 'utf8', env }) };
}
const reftableOk = ((): boolean => { const t = tempDir('reftable-probe-'); return spawnSync('git', ['init', '-q', '--ref-format=reftable', t], { encoding: 'utf8' }).status === 0; })();
const reftableSkip = skipSh || (reftableOk ? false : 'this git has no reftable');

test('reftable: a fresh install with init.defaultRefFormat=reftable still gets a bare-sha .git/HEAD and a valid marker', { skip: reftableSkip }, () => {
  const w = tempDir('install-reftable-cfg-'); const cfg = join(w, 'gitconfig');
  writeFileSync(cfg, '[init]\n\tdefaultRefFormat = reftable\n');
  const r = rig('install-reftable-', { GIT_CONFIG_GLOBAL: px(cfg) });
  const out = r.install();
  assert.equal(out.status, 0, String(out.stdout) + String(out.stderr));
  const dir = join(r.w, 'inst');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.equal(readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim(), head, '.git/HEAD is the bare sha');
  assert.equal(JSON.parse(readFileSync(join(dir, '.legion-install.json'), 'utf8')).head, head);
});

test('reftable: an existing reftable clone is installed anyway, with a warning and no marker, and the launcher is written', { skip: reftableSkip }, () => {
  const r = rig('install-reftable-existing-');
  git(r.w, 'clone', '-q', '--ref-format=reftable', '--depth', '1', '--branch', 'v0.99.0', `file://${r.wp}/base/dnh33/legion.git`, join(r.w, 'inst'));
  assert.match(readFileSync(join(r.w, 'inst', '.git', 'HEAD'), 'utf8'), /\.invalid/, 'the probe clone really is reftable');
  const out = r.install();
  assert.equal(out.status, 0, String(out.stdout) + String(out.stderr));
  assert.match(String(out.stderr), /Legion is installed, but it could not mark this folder for self-update; updates will show a notice instead\./);
  assert.equal(existsSync(join(r.w, 'inst', '.legion-install.json')), false);
  assert.equal(existsSync(join(r.w, 'home', '.local', 'bin', 'legion')), true, 'the launcher is there');
});

test('a running Legion in the folder stops the installer before it touches node_modules', { skip: skipSh }, () => {
  const r = rig('install-running-');
  assert.equal(r.install().status, 0);
  const dir = join(r.w, 'inst');
  writeFileSync(join(dir, 'node_modules', 'keep'), '1');
  const real = spawnSync('sh', ['-c', 'cd "$1" && pwd -P', 'sh', r.inst], { encoding: 'utf8' }).stdout.trim();
  const ps = fakePs(r.w, [`${real}/node_modules/electron/dist/electron ${real}`]);
  const out = spawnSync('sh', [px(installSh), '--no-launch', '--dir', r.inst, '--version', '0.99.0'], { encoding: 'utf8', env: { ...r.env, PATH: `${ps}:${r.env.PATH}` } });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /Legion is running from .* Close it/);
  assert.equal(existsSync(join(dir, 'node_modules', 'keep')), true, 'node_modules was not deleted');
});
