// Builds the test map: compiles, runs the WHOLE suite once with record.mjs in every Node process, and writes
// .testmap/map.json (per test file: the repository files and folders its run touched). Usage: npm run test:map
// The map is only as good as that run: select.mjs refuses to narrow anything the map cannot vouch for.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
process.chdir(REPO);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

console.log('[test-map] building');
execSync('npm run build:ts', { stdio: 'inherit' });

const out = mkdtempSync(join(tmpdir(), 'legion-testmap-'));
const recorder = pathToFileURL(join(REPO, 'scripts', 'test-map', 'record.mjs')).href;
const env = { ...process.env, LEGION_TESTMAP_OUT: out, LEGION_TESTMAP_REPO: REPO, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${recorder}`.trim() };
delete env.LEGION_TESTMAP_OWNER;
mkdirSync('.testmap', { recursive: true });
console.log('[test-map] running the full suite with the recorder (log: .testmap/run.log)');
const run = spawnSync(process.execPath, ['--test', 'dist/test/*.test.js'], { env, encoding: 'utf8', maxBuffer: 1 << 30 });
writeFileSync('.testmap/run.log', (run.stdout ?? '') + (run.stderr ?? ''));
const summary = (run.stdout ?? '').split('\n').filter((l) => /^ℹ (tests|pass|fail) /.test(l)).join('  ');

/** A path the run touched, as the source path a change would show up under; null = no repository source behind it. */
const toSource = (r) => {
  let s = r;
  if (s.startsWith('dist/context-layer/')) s = s.slice('dist/context-layer/'.length);
  else if (s === 'dist' || s === 'dist/context-layer') return null;
  else if (s.startsWith('dist/')) s = s.slice(5);
  else return r; // a source path: kept even if it does not exist (a test that checks absence depends on it too)
  if (s.endsWith('.js')) for (const ext of ['.ts', '.tsx', '.mts']) { const t = s.slice(0, -3) + ext; if (existsSync(t)) return t; }
  if (s.endsWith('.js.map')) return null;
  return existsSync(s) ? s : null;
};
const ownerSource = (o) => o.replace(/^dist\//, '').replace(/\.js$/, '.ts');

const tests = {};
const unowned = { files: new Set(), dirs: new Set(), argv: new Set(), opaque: new Set() };
let records = 0;
for (const f of readdirSync(out)) {
  const r = JSON.parse(readFileSync(join(out, f), 'utf8'));
  records++;
  const t = r.owner ? (tests[ownerSource(r.owner)] ??= { files: new Set(), dirs: new Set(), unmapped: new Set(), opaque: new Set() }) : null;
  for (const o of r.opaque ?? []) (t ? t.opaque : unowned.opaque).add(o);
  for (const [list, key] of [[r.files, 'files'], [r.dirs, 'dirs']]) {
    for (const p of list) {
      const s = toSource(p);
      if (!t) { if (s) unowned[key].add(s); else unowned.argv.add(p); continue; }
      if (s) t[key].add(s); else if (!/^dist(\/context-layer)?$/.test(p) && !p.endsWith('.js.map')) t.unmapped.add(p);
    }
  }
  if (!r.owner) unowned.argv.add((r.argv ?? []).join(' '));
}
rmSync(out, { recursive: true, force: true });

const allTests = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`).sort();
const missing = allTests.filter((t) => !tests[t]);
const map = {
  version: 1,
  commit: sh('git rev-parse HEAD'),
  dirtyAtBuild: sh('git status --porcelain --untracked-files=no').split('\n').filter(Boolean).map((l) => l.slice(3)),
  node: process.versions.node,
  builtAt: new Date().toISOString(),
  suite: summary,
  tests: Object.fromEntries(Object.entries(tests).sort().map(([k, v]) => [k, {
    files: [...v.files].sort(), dirs: [...v.dirs].sort(),
    ...(v.opaque.size || v.unmapped.size ? { always: [
      v.opaque.size ? `starts ${[...v.opaque].sort().slice(0, 4).join(', ')}, which the recorder cannot see inside` : '',
      v.unmapped.size ? `reads build output with no source behind it: ${[...v.unmapped].slice(0, 3).join(', ')}` : '',
    ].filter(Boolean).join('; ') } : {}),
  }])),
  // a test file that left no record (it crashed before exit, or never ran) is always selected
  unrecorded: missing,
  unowned: { files: [...unowned.files].sort(), dirs: [...unowned.dirs].sort(), opaque: [...unowned.opaque].sort(), processes: [...unowned.argv].filter(Boolean).sort() },
};
writeFileSync('.testmap/map.json', JSON.stringify(map, null, 1));
const always = Object.values(map.tests).filter((t) => t.always).length;
console.log(`[test-map] ${records} process records, ${Object.keys(map.tests).length} of ${allTests.length} test files mapped, ${always} always-run, ${missing.length} unrecorded, ${map.unowned.files.length + map.unowned.dirs.length} unowned paths`);
console.log(`[test-map] suite: ${summary}`);
console.log('[test-map] wrote .testmap/map.json');
