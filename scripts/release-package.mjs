#!/usr/bin/env node
// Builds legion-<version>-app.zip from an already BUILT tree: only the update code set, one top folder legion-<version>/, deterministic.
// usage: node scripts/release-package.mjs --out <folder> [--root <built tree, default: this repo>] [--published-at <UTC ISO>]
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { args, die, loadDist, REPO, writeZip } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { out: 'v', root: 'v', 'published-at': 'v' });
if (!a.out) die('usage: node scripts/release-package.mjs --out <folder> [--root <built tree>]');
const root = resolve(a.root ?? REPO);
const { CODE_SET } = await loadDist('src/core/updater/apply.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(pkg.version)) die(`package.json version "${pkg.version}" is not a plain MAJOR.MINOR.PATCH`);
for (const must of ['dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'package-lock.json']) if (!existsSync(join(root, must))) die(`not a built tree: ${must} is missing (run npm run build first)`);
for (const [src, built] of [['src', 'dist/src']]) if (existsSync(join(root, src)) && statSync(join(root, built)).mtimeMs + 3600_000 < latest(join(root, src))) die(`dist looks older than ${src}: rebuild before packaging`);
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
entries.push({ name: `${top}/build-info.json`, data: Buffer.from(JSON.stringify({ version: pkg.version, publishedAt }) + '\n') });
entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
mkdirSync(resolve(a.out), { recursive: true });
const file = join(resolve(a.out), `legion-${pkg.version}-app.zip`);
writeFileSync(file, writeZip(entries), { flag: 'w' });
console.log(`wrote ${file} (${entries.length} files, version ${pkg.version}, publishedAt ${publishedAt})`);
