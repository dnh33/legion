// Picks the test files a change can affect, from .testmap/map.json (npm run test:map builds it).
// Usage: node scripts/test-map/select.mjs [--run] [--why] [--changed a,b,...] [--skipped]
//   --changed  ask about these paths instead of what git says changed ("what would this change run?")
//   --skipped  print the test files NOT selected (the soundness check runs exactly these)
//   (no flag)  print the selected test files
//   --why      also print, per selected file, the changed path that selected it
//   --run      compile, then run the selection with node --test (exit code is the run's)
// Changed = everything that differs from the map's commit: committed, staged, unstaged and untracked.
// It falls back to the WHOLE suite whenever the map cannot vouch for a change; it never guesses.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
process.chdir(REPO);
const args = process.argv.slice(2);
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const allTests = readdirSync('test').filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`).sort();

/** Anything here changes how every test builds or runs: the map cannot narrow it. */
const GLOBAL = ['package.json', 'package-lock.json', 'tsconfig.json', 'ui/tsconfig.json', '.gitattributes', '.nvmrc', 'scripts/copy-static.mjs'];
// the map's facts come from the recorder and the builder; a change to this selector does not make them untrue
const GLOBAL_PREFIX = ['scripts/test-map/record.mjs', 'scripts/test-map/build.mjs'];

function decide() {
  if (!existsSync('.testmap/map.json')) return { full: 'no test map yet (run npm run test:map)' };
  const map = JSON.parse(readFileSync('.testmap/map.json', 'utf8'));
  if (map.version !== 1) return { full: 'the test map is from another version of this script' };
  if (map.node.split('.')[0] !== process.versions.node.split('.')[0]) return { full: `the map was built on Node ${map.node}, this is ${process.versions.node}` };
  let changed;
  const given = args.indexOf('--changed');
  if (given >= 0) changed = new Set(String(args[given + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  else try {
    changed = new Set([
      ...sh(`git diff --name-only ${map.commit}`).split('\n'),
      ...sh('git ls-files --others --exclude-standard').split('\n'),
      // files that were already dirty when the map was built may have changed since: count them as changed
      ...(map.dirtyAtBuild ?? []),
    ].map((s) => s.trim()).filter(Boolean));
  } catch { return { full: `the map's commit ${String(map.commit).slice(0, 8)} is not in this repository` }; }
  if (!changed.size) return { tests: [], changed, why: new Map() };
  // a program nobody owns and nobody can see inside may have read anything: nothing can be narrowed
  if (map.unowned.opaque?.length) return { full: `an unowned process started ${map.unowned.opaque[0]}, whose reads the map cannot know`, changed };

  const hits = (rec, c) => rec.files.includes(c) || rec.dirs.some((d) => c === d || c.startsWith(d + '/'));
  for (const c of changed) {
    if (GLOBAL.includes(c) || GLOBAL_PREFIX.some((p) => c.startsWith(p))) return { full: `${c} changes how every test runs`, changed };
    if (hits(map.unowned, c)) return { full: `${c} was read by a process the map could not tie to a test file`, changed };
  }
  const why = new Map();
  const add = (t, reason) => { if (!why.has(t)) why.set(t, reason); };
  for (const t of allTests) {
    const rec = map.tests[t];
    if (!rec) { add(t, 'not in the map (new, or it left no record)'); continue; }
    if (rec.always) { add(t, rec.always); continue; }
    for (const c of changed) if (hits(rec, c)) { add(t, c); break; }
  }
  return { tests: [...why.keys()].sort(), changed, why };
}

const d = decide();
const tests = d.full ? allTests : d.tests;
const head = d.full
  ? `[test-map] FULL suite (${allTests.length} files): ${d.full}`
  : `[test-map] ${d.changed.size} changed path(s) -> ${tests.length} of ${allTests.length} test files`;
console.error(head);
if (args.includes('--skipped')) {
  for (const t of allTests.filter((x) => !tests.includes(x))) console.log(t);
  process.exit(0);
}
if (!args.includes('--run')) {
  for (const t of tests) console.log(args.includes('--why') && d.why ? `${t}\t<- ${d.why.get(t)}` : t);
  process.exit(0);
}
if (!tests.length) { console.error('[test-map] nothing to run'); process.exit(0); }
execSync('npm run build:ts', { stdio: 'inherit' });
const files = tests.map((t) => t.replace(/^test\//, 'dist/test/').replace(/\.ts$/, '.js'));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
console.error(head);
process.exit(r.status ?? 1);
