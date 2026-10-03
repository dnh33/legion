#!/usr/bin/env node
/**
 * Scrub a Legion checkout into a publishable snapshot with a fresh, single-commit history.
 *
 *   node scripts/export-public.mjs <src-dir> <out-dir>
 *
 * Policy (see claude/tracker-public-audit.md and the tracker's OPEN-SOURCING PLAN):
 *  - Excluded wholesale: .git, node_modules, dist, dist-ui, claude/skills/** (the owner's private skills),
 *    review/**, docs/video-v2/shots/ (playwright capture intermediates).
 *  - Line-scrubbed (paths, owner first name, private hosts, cloud session ids, wallet-port references) in PROSE
 *    only: claude/**, docs/**, the root docs, .github templates.
 *  - Code, tests and scripts ship as-is, EXCEPT three runtime guard VALUES that name the wallet port are
 *    rewritten to the number-form the codebase already uses (Number('33'+'21')) so they keep working.
 *  - Detection guardrails ship untouched: the bsv tripwire/scan/guard tests and the BSV pack content deliberately
 *    contain the port so they can detect it — stripping them would gut the safety the owner demands (audit H3).
 *  - Fresh history: one initial commit ("Legion 0.2.0") under a neutral identity.
 *  - Writes scrub-report.json (per-file scrub counts) into the out dir root.
 *
 * The snapshot is built for a NEW public repo at dnh33/legion. The owner does the repo rename + making it public,
 * and runs a final secrets/personal-data scan before publishing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const [, , srcArg, outArg] = process.argv;
if (!srcArg || !outArg) {
  console.error('usage: node scripts/export-public.mjs <src-dir> <out-dir>');
  process.exit(2);
}
const SRC = resolve(srcArg);
const OUT = resolve(outArg);
if (!existsSync(join(SRC, 'package.json'))) {
  console.error(`not a Legion checkout: ${SRC} (package.json missing)`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Top-level paths that never ship. */
const EXCLUDE = new Set([
  '.git', 'node_modules', 'dist', 'dist-ui', 'review',
  'claude/skills', 'docs/video-v2/shots',
]);

/**
 * Scrub scope. Code, tests and scripts ship untouched (the history audit found no leak there; test fixtures
 * with generic paths like C:\Users\Dan are fine per tracker-public-audit H6). The line scrub applies to prose:
 * claude/**, docs/**, the root docs, .github templates. The wallet-port rule also applies to the BSV pack prose.
 */
const PROSE_DIRS = ['claude', 'docs'];
const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'NOTICE', 'LICENSE', 'CLAUDE.md'];
// The wallet port is never written literally in code; it is built at runtime the same way the codebase does it.
const PORT = String(Number('33' + '21'));
// Guard constants and refusal URLs that name the real wallet port: keep them working, drop the literal, by
// rewriting to the number-form the codebase already uses for it elsewhere.
const PORT_REWRITES = [
  { file: 'scripts/harness/fake-wallet.mjs', subs: [[new RegExp('\\b' + PORT + '\\b', 'g'), "Number('33' + '21')"]] },
  { file: 'test/bsv-fake-wallet.ts', subs: [[new RegExp('\\b' + PORT + '\\b', 'g'), "Number('33' + '21')"]] },
  { file: 'test/bsv-fix-round.test.ts', subs: [["'http://203.0.113.9:" + PORT + "'", "'http://203.0.113.9:' + Number('33' + '21')"]] },
];

/** Line-level scrub rules, applied to text files. Order matters (paths before names). */
const REDACT = '[redacted]';
const PORT_RULE = [new RegExp('\\b' + PORT + '\\b', 'g'), REDACT];
const RULES = [
  // local absolute paths (any drive letter, forward or back slash)
  [/[A-Za-z]:[\\/](?:Users|bots|Aetherkeep|dev|tmp|hermes)\b[^"'\s)]*/g, REDACT],
  [/\/(?:opt|home|tmp|root|var)\b[^"'\s)]*/g, REDACT],
  // the owner's first name (in prose; 'Dan' alone is a generic test name and stays)
  [/\bDaniel\b/g, 'the owner'],
  // private hosts / services
  [/(?:rune-vps|tailscale)[^\s"')\]]*/gi, REDACT],
  // cloud session ids
  [/session_[A-Za-z0-9_-]{6,}/g, REDACT],
  // the real wallet port, wherever docs/seed prose writes it as a literal (code and tests never do;
  // tests build it with Number('33' + '21') and those tests stay untouched)
  PORT_RULE,
];

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.css', '.html', '.astro', '.yml', '.yaml', '.svg', '.ps1', '.sh', '.gitignore', '.gitattributes']);

const report = [];
let scrubbedFiles = 0, scrubbedLines = 0;

function scrubFile(srcPath, dstPath) {
  const rel = relative(SRC, srcPath).replace(/\\/g, '/');
  const ext = '.' + (basename(srcPath).includes('.') ? srcPath.split('.').pop() : '');
  const isText = TEXT_EXT.has(ext) || basename(srcPath).startsWith('.');
  if (!isText) return;
  let rules;
  const rw = PORT_REWRITES.find((r) => r.file === rel);
  if (rw) rules = rw.subs;
  else if (PROSE_DIRS.some((d) => rel === d || rel.startsWith(d + '/')) || ROOT_DOCS.includes(rel) || rel.startsWith('.github/')) rules = RULES;
  else return;
  const raw = readFileSync(srcPath, 'utf8');
  let changed = 0;
  let out = raw;
  for (const [re, to] of rules) out = out.replace(re, (m) => { changed++; return to; });
  if (changed === 0) return;
  writeFileSync(dstPath, out);
  scrubbedFiles++; scrubbedLines += changed;
  report.push({ file: rel, scrubs: changed });
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(SRC, p).replace(/\\/g, '/');
    if (EXCLUDE.has(rel)) continue;
    const st = statSync(p);
    const dst = join(OUT, rel);
    if (st.isDirectory()) { mkdirSync(dst, { recursive: true }); walk(p); }
    else { mkdirSync(join(dst, '..'), { recursive: true }); cpSync(p, dst); scrubFile(p, dst); }
  }
}

console.log(`exporting ${SRC} -> ${OUT}`);
walk(SRC);
writeFileSync(join(OUT, 'scrub-report.json'), JSON.stringify({ scrubbedFiles, scrubbedLines, files: report }, null, 2) + '\n');

// fresh history: one initial commit
execFileSync('git', ['init', '-q'], { cwd: OUT });
execFileSync('git', ['-c', 'user.name=Legion', '-c', 'user.email=legion@localhost', 'add', '-A'], { cwd: OUT });
execFileSync('git', ['-c', 'user.name=Legion', '-c', 'user.email=legion@localhost', 'commit', '-q', '-m', 'Legion 0.2.0'], { cwd: OUT });

console.log(`done: ${scrubbedFiles} files scrubbed (${scrubbedLines} lines), fresh single-commit history in ${OUT}`);
console.log('scrub-report.json written; review it before the owner publishes.');
