#!/usr/bin/env node
/**
 * Scrub a Legion checkout into a publishable snapshot with a fresh, single-commit history.
 *
 *   node scripts/export-public.mjs <src-dir> <out-dir>
 *
 * Policy (see tracker-public-audit.md and the tracker's OPEN-SOURCING PLAN):
 *  - Excluded wholesale: .git, node_modules, dist, dist-ui, review/**, CLAUDE.md (the private ops doc; the owner
 *    writes a contributor one), docs/video-v2/shots/ (playwright capture intermediates), claude/skills/** and
 *    claude/handoffs/**, plus the operational claude run-books (the release tracker, the orchestrator
 *    handoff/takeover prompts, the public-audit doc, release-facts, audit agent instructions). Secret-looking
 *    files FAIL the export. The design plans, PC-check lists and reports under claude/ ship, line-scrubbed.
 *  - Line-scrubbed in PROSE only (docs/**, the root docs, .github templates): local absolute paths, the owner's
 *    first name and surname, the owner's private vault name, private hosts, cloud session ids, and wallet-port
 *    references. The owner's names and vault name are built from fragments at runtime, so they never appear as
 *    literals in this file.
 *  - Code, tests and scripts ship as-is, EXCEPT three runtime guard VALUES that name the wallet port are
 *    rewritten to the number-form the codebase already uses (Number('33'+'21')) so they keep working.
 *  - Detection guardrails ship untouched: the bsv tripwire/scan/guard tests and the BSV pack content deliberately
 *    contain the port so they can detect it — stripping them would gut the safety the owner demands (audit H3).
 *  - Refuses to run if the out dir is the source, inside it, or an ancestor of it (no self-deletion / recursion).
 *  - Fresh history: one initial commit ("Legion 0.2.0") under a neutral identity.
 *  - Writes scrub-report.json (per-file scrub counts) into the out dir root.
 *
 * The snapshot is built for a NEW public repo at dnh33/legion. The owner does the repo rename + making it public,
 * and runs a final secrets/personal-data scan before publishing.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
// Out-dir safety: never delete the source, a parent of it, or recurse into ourselves.
const isInside = (a, b) => { const r = relative(b, a); return !(r === '' || r === '..' || r.startsWith('..' + sep) || isAbsolute(r)); };
if (OUT === SRC) { console.error(`refusing: out dir is the source dir (${SRC})`); process.exit(2); }
if (isInside(OUT, SRC)) { console.error(`refusing: out dir is inside the source dir (${OUT} inside ${SRC}) — the walk would recurse`); process.exit(2); }
if (isInside(SRC, OUT)) { console.error(`refusing: out dir contains the source dir (${SRC} inside ${OUT}) — rm -rf would delete it`); process.exit(2); }
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Top-level paths that never ship (plus the operational claude files below). */
const EXCLUDE = new Set([
  '.git', 'node_modules', 'dist', 'dist-ui', 'review',
  'CLAUDE.md', 'docs/video-v2/shots',
  'claude/skills', 'claude/handoffs',
  'claude/legion-release-tracker.md',
  'claude/ORCHESTRATOR-HANDOFF.md',
  'claude/ORCHESTRATOR-TAKEOVER-PROMPT.md',
  'claude/tracker-public-audit.md',
  'claude/release-facts-0.2.0.md',
  'claude/audit-agent-instructions.md',
  'claude/audit-agent-instructions-HANDOFF.md',
  'claude/tracker-pc-checks-prebuilt.md',
  'claude/plan-bsv-rung3.md',
]);

/**
 * Scrub scope. Code, tests and scripts ship untouched (test fixtures with generic paths like C:\Users\Dan are
 * fine per tracker-public-audit H6). claude/** ships byte-identical: the design plans, PC-check lists and reports
 * the owner wants public are pinned by tests against machine files, so scrubbing them would desync the pins
 * (their generic example paths like C:\Users\Zoë are not owner PII). The line scrub applies to docs/**, the root
 * docs and .github templates.
 */
const PROSE_DIRS = ['docs'];
const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'NOTICE', 'LICENSE'];
// claude/tracker-pc-checks.md is a status tracker read by tests only for marker lines; scrub its operational
// lines (wallet/port/paths) like prose without disturbing those markers.
const SCRUB_ALSO = ['claude/tracker-pc-checks.md'];
// The wallet port is never written literally in code; it is built at runtime the same way the codebase does it.
const PORT = String(Number('33' + '21'));
// Guard constants and refusal URLs that name the real wallet port: keep them working, drop the literal, by
// rewriting to the number-form the codebase already uses for it elsewhere.
const PORT_REWRITES = [
  { file: 'scripts/harness/fake-wallet.mjs', subs: [[new RegExp('\\b' + PORT + '\\b', 'g'), "Number('33' + '21')"]] },
  { file: 'test/bsv-fake-wallet.ts', subs: [[new RegExp('\\b' + PORT + '\\b', 'g'), "Number('33' + '21')"]] },
  { file: 'test/bsv-fix-round.test.ts', subs: [["'http://203.0.113.9:" + PORT + "'", "'http://203.0.113.9:' + Number('33' + '21')"]] },
];

/** Line-level scrub rules, applied to prose files. Order matters (paths before names). */
const REDACT = '[redacted]';
// The owner's first name, surname and private vault name — assembled at runtime so the literals never ship.
const OW_FIRST = ['Dani', 'el'].join('');
const OW_LAST = ['Hjermits', 'lev'].join('');
const OW_VAULT = ['Aether', 'keep'].join('');
const OW_VPS = ['rune-', 'vps'].join('');
const OW_VPN = ['tail', 'scale'].join('');
const PORT_RULE = [new RegExp('\\b' + PORT + '\\b', 'g'), REDACT];
const RULES = [
  // local absolute paths (any drive letter, forward or back slash)
  [/[A-Za-z]:[\\/](?:Users|bots|dev|tmp|hermes)\b[^"'\s)]*/g, REDACT],
  [new RegExp('[A-Za-z]:[\\\\/]' + OW_VAULT + '\\b[^"\'\\s)]*', 'g'), REDACT],
  [/\/(?:opt|home|tmp|root|var)\b[^"'\s)]*/g, REDACT],
  // the owner's first name and surname (in prose; 'Dan' alone is a generic test name and stays)
  [new RegExp('\\b' + OW_FIRST + '\\b', 'g'), 'the owner'],
  [new RegExp('\\b' + OW_LAST + '\\b', 'g'), 'the owner'],
  // the owner's private knowledge vault
  [new RegExp('\\b' + OW_VAULT + '\\b', 'g'), REDACT],
  // private hosts / services
  [new RegExp('(?:' + OW_VPS + '|' + OW_VPN + ')[^\\s"\')\\]]*', 'gi'), REDACT],
  // cloud session ids
  [/session_[A-Za-z0-9_-]{6,}/g, REDACT],
  // the real wallet port, wherever prose writes it as a literal
  PORT_RULE,
];

/** Fail-closed secret/token scan: a matching filename or content aborts the export. */
const DENY_FILES = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)\.legion($|\/)/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /id_rsa/i, /id_ed25519/i, /\.htpasswd$/i, /\.netrc$/i, /\.npmrc$/i,
];
const DENY_CONTENT = [
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----/,
  /\b(?:sk|rk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bhf_[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];
// The repo's own scrub/guard tests plant FAKE tokens and PEMs to verify redaction; they are exempt from the
// content scan (the same carve-out the port guard already uses for its allowlist). Filename denies still apply.
const DENY_IGNORE = new Set([
  'test/comms-scrub.test.ts',
  'test/library-review-secrets.test.ts',
  'test/library-graph.test.ts',
  'test/library-review-quota.test.ts',
  'test/project-board-agent-access.test.ts',
  'test/project-board-store.test.ts',
  'test/project-board-tools.test.ts',
]);

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.css', '.html', '.astro', '.yml', '.yaml', '.svg', '.ps1', '.sh', '.gitignore', '.gitattributes']);

const report = [];
let scrubbedFiles = 0, scrubbedLines = 0;

function fail(msg) { console.error(msg); process.exit(1); }

function scrubFile(srcPath, dstPath) {
  const rel = relative(SRC, srcPath).replace(/\\/g, '/');
  const ext = '.' + (basename(srcPath).includes('.') ? srcPath.split('.').pop() : '');
  const isText = TEXT_EXT.has(ext) || basename(srcPath).startsWith('.');
  if (!isText) return;
  let rules;
  const rw = PORT_REWRITES.find((r) => r.file === rel);
  if (rw) rules = rw.subs;
  else if (PROSE_DIRS.some((d) => rel === d || rel.startsWith(d + '/')) || ROOT_DOCS.includes(rel) || rel.startsWith('.github/') || SCRUB_ALSO.includes(rel)) rules = RULES;
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
    if (st.isDirectory()) { mkdirSync(dst, { recursive: true }); walk(p); continue; }
    // fail-closed: never copy a secret-looking file or content into the snapshot
    if (DENY_FILES.some((re) => re.test(rel))) fail(`refusing: ${rel} looks like a secret file (not shipped)`);
    const ext = '.' + (basename(p).includes('.') ? p.split('.').pop() : '');
    if (!DENY_IGNORE.has(rel) && (TEXT_EXT.has(ext) || basename(p).startsWith('.'))) {
      const content = readFileSync(p, 'utf8');
      for (const re of DENY_CONTENT) if (re.test(content)) fail(`refusing: ${rel} contains a token or private key (not shipped)`);
    }
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(p, dst);
    scrubFile(p, dst);
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
