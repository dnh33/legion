#!/usr/bin/env node
// Reads a list of git tags on stdin (one per line) and prints the highest release tag (v<MAJOR.MINOR.PATCH[-letter]>) that is
// lower than --version. Prints nothing when there is none. Used by release-build.yml to find the lock to compare with.
// A lettered patch ranks above its plain release's predecessor and below the plain release itself (0.2.7-a < 0.2.7), as in the app.
import { readFileSync } from 'node:fs';
import { args, die, isReleaseVersion } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { version: 'v' });
if (!isReleaseVersion(a.version)) die('usage: git tag --list "v*" | node scripts/release-previous-tag.mjs --version <version>');
const key = (v) => { const [core, letter] = v.split('-'); return [...core.split('.').map(Number), letter ? letter.charCodeAt(0) - 96 : 100]; };
const cmp = (x, y) => { const p = key(x), q = key(y); for (let i = 0; i < 4; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };
const tags = readFileSync(0, 'utf8').split(/\r?\n/).map((t) => t.trim()).filter((t) => t.startsWith('v') && isReleaseVersion(t.slice(1)));
const lower = tags.filter((t) => cmp(t.slice(1), a.version) < 0).sort((x, y) => cmp(x.slice(1), y.slice(1)));
if (lower.length) console.log(lower[lower.length - 1]);
