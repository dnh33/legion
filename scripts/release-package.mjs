#!/usr/bin/env node
// Builds legion-<version>-app.zip from an already BUILT tree: only the update code set, one top folder legion-<version>/, deterministic.
// usage: node scripts/release-package.mjs --out <folder> [--root <built tree, default: this repo>] [--published-at <UTC ISO>] [--build-info <json file>]
// --build-info: extra fields (platform, kind, commit, ...) merged into build-info.json after version and publishedAt (build-package.mjs uses it).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { args, die, isReleaseVersion, loadDist, REPO, writeZip } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { out: 'v', root: 'v', 'published-at': 'v', 'build-info': 'v' });
if (!a.out) die('usage: node scripts/release-package.mjs --out <folder> [--root <built tree>]');
const root = resolve(a.root ?? REPO);
const { CODE_SET } = await loadDist('src/core/updater/apply.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!isReleaseVersion(pkg.version)) die(`package.json version "${pkg.version}" is not MAJOR.MINOR.PATCH with an optional single-letter patch suffix (e.g. 0.2.2-a)`);
for (const must of ['dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'package-lock.json']) if (!existsSync(join(root, must))) die(`not a built tree: ${must} is missing (run npm run build first)`);
// Compare the NEWEST COMPILED FILE, not the directory's own mtime. tsc rewrites files in place and never touches the
// directory, so a perfectly fresh dist reported itself hours stale and blocked packaging with "dist looks older than
// src". A directory mtime only moves when entries are added or removed. Found 2026-10-04 while cutting 0.2.3-a.
for (const [src, built] of [['src', 'dist/src']]) if (existsSync(join(root, src)) && latest(join(root, built)) + 3600_000 < latest(join(root, src))) die(`dist looks older than ${src}: rebuild before packaging`);
const publishedAt = a['published-at'] ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(publishedAt)) die('--published-at must look like 2026-10-20T10:00:00Z');

function latest(dir) { let m = 0; for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p); m = Math.max(m, s.isDirectory() ? latest(p) : s.mtimeMs); } return m; }
const top = `legion-${pkg.version}`;
const entries = [];
const skip = (rel) => rel === 'dist/test' || rel.startsWith('dist/test/') || rel.split('/').includes('node_modules');
function add(rel) {
  const p = join(root, rel); const st = lstatSync(p);
  if (st.isSymbolicLink()) die(`refusing a link: ${rel}`);
  if (skip(rel)) return;
  if (st.isDirectory()) { for (const n of readdirSync(p).sort()) add(`${rel}/${n}`); return; }
  if (rel.length > 190) die(`path too long: ${rel}`);
  entries.push({ name: `${top}/${rel}`, data: readFileSync(p) });
}
for (const n of CODE_SET) { if (n === 'build-info.json') continue; if (existsSync(join(root, n))) add(n); }
const extra = a['build-info'] ? JSON.parse(readFileSync(resolve(a['build-info']), 'utf8')) : {};
entries.push({ name: `${top}/build-info.json`, data: Buffer.from(JSON.stringify({ ...extra, version: pkg.version, publishedAt }) + '\n') });
entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
mkdirSync(resolve(a.out), { recursive: true });
const file = join(resolve(a.out), `legion-${pkg.version}-app.zip`);
writeFileSync(file, writeZip(entries), { flag: 'w' });
console.log(`wrote ${file} (${entries.length} files, version ${pkg.version}, publishedAt ${publishedAt})`);
