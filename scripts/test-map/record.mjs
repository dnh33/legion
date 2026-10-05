// Test-map recorder. Loaded into every Node process of a full test run through NODE_OPTIONS (see build.mjs), so it also
// runs inside processes a test spawns. It records, per test file, what that file's run touched in the repository:
//   - every module it loaded (ESM and CommonJS, through module.registerHooks),
//   - every file or folder it read through node:fs (read, stat, exists, readdir, copy, stream),
//   - every repository path it handed to a child process (spawn, exec, fork, and their sync forms).
// select.mjs turns that into "which test files can a change to these files affect". Off unless LEGION_TESTMAP_OUT is set.
import fs from 'node:fs';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.env.LEGION_TESTMAP_OUT;
const REPO = process.env.LEGION_TESTMAP_REPO;

if (OUT && REPO) {
  if (typeof registerHooks !== 'function') {
    // without module hooks the map would silently miss every import: refuse rather than write a map that lies
    process.stderr.write('[test-map] module.registerHooks is missing (Node 22.15+ / 23.5+ needed); not recording\n');
    process.exit(70);
  }
  const root = resolve(REPO) + sep;
  const orig = { appendFileSync: fs.appendFileSync, mkdirSync: fs.mkdirSync, statSync: fs.statSync };

  // The test file this process belongs to: a test process is `node <repo>/dist/test/x.test.js`. Processes it spawns
  // inherit the owner through the environment. A process with neither is recorded as unowned (select.mjs then refuses
  // to narrow any change that such a process touched).
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : '';
  if (argv1.startsWith(root) && /[\\/]dist[\\/]test[\\/][^\\/]+\.test\.js$/.test(argv1)) {
    process.env.LEGION_TESTMAP_OWNER = argv1.slice(root.length).split(sep).join('/');
  }
  const owner = process.env.LEGION_TESTMAP_OWNER ?? null;
  // the `node --test` runner itself (the flag is in execArgv, not argv): it only lists and spawns the test files
  const isRunner = !owner && process.execArgv.includes('--test');

  // Each new path is written the moment it is seen, not at exit: a test that ends a child with kill() (a hard
  // TerminateProcess on Windows) never runs that child's exit handlers, and its reads would be lost. One JSON line
  // per entry; the first line names the owner.
  const recFile = join(OUT, `${process.pid}-${Date.now()}.jsonl`);
  let started = false;
  const emit = (o) => {
    if (isRunner) return;
    try {
      if (!started) { orig.mkdirSync.call(fs, OUT, { recursive: true }); orig.appendFileSync.call(fs, recFile, JSON.stringify({ owner, argv: process.argv.slice(1, 3) }) + '\n'); started = true; }
      orig.appendFileSync.call(fs, recFile, JSON.stringify(o) + '\n');
    } catch { /* recording never breaks a test */ }
  };
  const seen = (set, key, value) => { if (!set.has(value)) { set.add(value); emit({ [key]: value }); } };
  const files = new Set();
  const dirs = new Set();
  const rel = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
    let s = p instanceof URL ? (p.protocol === 'file:' ? fileURLToPath(p) : null) : String(p);
    if (!s) return null;
    if (s.startsWith('file:')) { try { s = fileURLToPath(s); } catch { return null; } }
    const abs = isAbsolute(s) ? resolve(s) : resolve(process.cwd(), s);
    if (!(abs + sep).startsWith(root) && abs !== root.slice(0, -1)) return null;
    const r = abs.slice(root.length).split(sep).join('/');
    if (r === '' || r.startsWith('node_modules/') || r === 'node_modules' || r.startsWith('.git/')) return null;
    return r;
  };
  const noteFile = (p) => { const r = rel(p); if (r !== null) seen(files, 'f', r); };
  const noteDir = (p) => { const r = rel(p); if (r !== null) seen(dirs, 'd', r); };

  registerHooks({
    load(url, context, nextLoad) { if (url.startsWith('file:')) noteFile(url); return nextLoad(url, context); },
  });

  const wrap = (obj, name, note) => {
    const f = obj[name];
    if (typeof f !== 'function') return;
    obj[name] = function (...a) { try { note(a); } catch { /* recording never breaks a test */ } return f.apply(this, a); };
  };
  for (const n of ['readFileSync', 'readFile', 'existsSync', 'statSync', 'lstatSync', 'stat', 'lstat', 'access', 'accessSync', 'createReadStream', 'realpathSync', 'readlinkSync', 'openSync', 'open']) wrap(fs, n, (a) => noteFile(a[0]));
  for (const n of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, n, (a) => noteDir(a[0]));
  for (const n of ['cpSync', 'cp']) wrap(fs, n, (a) => noteDir(a[0]));
  for (const n of ['copyFileSync', 'copyFile']) wrap(fs, n, (a) => noteFile(a[0]));
  for (const n of ['readFile', 'stat', 'lstat', 'access', 'open', 'realpath']) wrap(fs.promises, n, (a) => noteFile(a[0]));
  for (const n of ['readdir', 'opendir']) wrap(fs.promises, n, (a) => noteDir(a[0]));
  wrap(fs.promises, 'cp', (a) => noteDir(a[0]));
  wrap(fs.promises, 'copyFile', (a) => noteFile(a[0]));

  // A path handed to another program: the program may read it and whatever sits beside it (a .ps1 that dot-sources its
  // neighbour), so a script counts as its whole folder.
  const noteArg = (s, cwd) => {
    if (typeof s !== 'string' || s.length > 4096) return;
    for (const piece of s.split(/[\s"'=]+/)) {
      if (!piece || piece.startsWith('-')) continue;
      const abs = isAbsolute(piece) ? piece : resolve(cwd ?? process.cwd(), piece);
      let st; try { st = orig.statSync.call(fs, abs); } catch { continue; }
      if (st.isDirectory()) noteDir(abs);
      else { noteFile(abs); if (/\.(ps1|psm1|cmd|bat|sh)$/i.test(abs)) noteDir(join(abs, '..')); }
    }
  };
  // A program the recorder cannot see inside (PowerShell, git, a shell, or a Node child whose environment drops the
  // recorder) may read any file it is pointed at, by a path in a temp script or one it computes. Its test is marked
  // always-run: the map never claims to know what such a program read.
  const opaque = new Set();
  const NODE_RE = /(^|[\\/])node(\.exe)?$/i;
  const noteOpaque = (name, a) => {
    const opts = a.find((x, i) => i > 0 && x && typeof x === 'object' && !Array.isArray(x));
    const env = opts && opts.env && typeof opts.env === 'object' ? opts.env : process.env;
    const traced = !!env.LEGION_TESTMAP_OUT && String(env.NODE_OPTIONS ?? '').includes('record.mjs');
    if (name === 'fork') { if (!traced) seen(opaque, 'x', 'a Node child without the recorder'); return; }
    if (name === 'exec' || name === 'execSync' || (opts && opts.shell)) { seen(opaque, 'x', `a shell command: ${String(a[0]).split(/\s+/)[0]}`); return; }
    const exe = String(a[0] ?? '');
    const isNode = exe === process.execPath || NODE_RE.test(exe);
    if (!isNode) seen(opaque, 'x', exe.split(/[\\/]/).pop() || exe);
    else if (!traced) seen(opaque, 'x', 'a Node child without the recorder');
  };
  const noteSpawn = (a, name) => {
    noteOpaque(name, a);
    const opts = a.find((x, i) => i > 0 && x && typeof x === 'object' && !Array.isArray(x));
    const cwd = opts && typeof opts.cwd === 'string' ? opts.cwd : undefined;
    if (cwd) noteDir(cwd);
    if (typeof a[0] === 'string') noteArg(a[0], cwd);
    if (Array.isArray(a[1])) for (const x of a[1]) noteArg(x, cwd);
  };
  for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) wrap(cp, n, (a) => noteSpawn(a, n));
  syncBuiltinESMExports();
  // a process that read nothing in the repository still leaves its owner line, so build.mjs sees every test file
  emit({ start: true });
}
