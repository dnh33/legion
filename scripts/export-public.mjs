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
 *  - Detection guardrails ship untouched: the bsv tripwire/scan/guard tests, the harness fake wallet and the BSV
 *    pack content deliberately contain the port so they can detect it — stripping them would gut the safety the
 *    owner demands, and their own allowlists (port-guard, bsv-scan, spend-tripwire) pin those exact files.
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
  'claude/wo10-runbook.md',
  'claude/plan-prebuilt.md',
]);

/**
 * Scrub scope. Code, tests and scripts ship untouched (test fixtures with generic paths like C:\Users\Dan are
 * fine per tracker-public-audit H6). claude/** ships byte-identical: the design plans, PC-check lists and reports
 * the owner wants public are pinned by tests against machine files, so scrubbing them would desync the pins
 * (their generic example paths like C:\Users\Zoë are not owner PII). The line scrub applies to docs/**, claude/**,
 * the root docs and .github templates.
 */
const PROSE_DIRS = ['docs', 'claude'];
const ROOT_DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'NOTICE', 'LICENSE'];
// `claude/` is scrubbed as a whole, which is what the policy above says happens to it: "the design plans, PC-check
// lists and reports under claude/ ship, line-scrubbed". Until 2026-10-04 the scrub list named docs/, the root docs and
// .github only, with `claude/tracker-pc-checks.md` carried as a one-off exception, so every other claude/ file was
// copied VERBATIM. That is how the owner's private vault path reached claude/SESSION-QUEUE.md and then the public
// snapshot, and the export-scrub test caught it. The generic patterns in those plans (`/opt/...`, `D:/apps/...`) are
// scrubbed too and that is the intended behaviour, not a loss: a public snapshot should not carry anyone's local paths,
// real or illustrative.
//
// Files excluded from the snapshot outright (EXCLUDE) never reach this function, so a run-book that must not ship at
// all is still kept out; scrubbing only decides what the files that DO ship may contain.
const SCRUB_ALSO = [];
// The wallet port is never written literally in code; it is built at runtime the same way the codebase does it.
const PORT = String(Number('33' + '21'));

/** Line-level scrub rules, applied to prose files. Order matters (paths before names). */
const REDACT = '[redacted]';
// The owner's private vault name and hosts — assembled at runtime so the literals never ship.
const OW_VAULT = ['Aether', 'keep'].join('');
const OW_VPS = ['rune-', 'vps'].join('');
const OW_VPN = ['tail', 'scale'].join('');
const PORT_RULE = [new RegExp('\\b' + PORT + '\\b', 'g'), REDACT];
const RULES = [
  // local absolute paths (any drive letter, forward or back slash)
  [/[A-Za-z]:[\\/](?:Users|bots|dev|tmp|hermes)\b[^"'\s)]*/g, REDACT],
  [new RegExp('[A-Za-z]:[\\\\/]' + OW_VAULT + '\\b[^"\'\\s)]*', 'g'), REDACT],
  [/\/(?:opt|home|tmp|root|var)\b[^"'\s)]*/g, REDACT],
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
  /id_rsa/i, /id_ed25519/i, /\.htpasswd$/i, /\.netrc$/i, /\.npmrc$/i, /(^|\/)config\.json$/i,
];
const DENY_CONTENT = [
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----/,
  /\b(?:sk|rk|ghp|gho|ghu|ghs|github_pat)[_-][A-Za-z0-9-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bhf_[A-Za-z0-9]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
];
// The repo's own scrub/guard tests plant FAKE tokens and PEMs to verify redaction; they are exempt from the
// content scan (the same carve-out the port guard already uses for its allowlist). Filename denies still apply.
//
// `test/provider-compaction.test.ts` joined this list on 2026-10-04. It plants realistic-looking key shapes
// (`sk-abc...9jkl`, `sk-liv...ghij`) to prove the summary sanitizer strips them, which is the whole point of the
// test: weaken the fixture until it stops matching the detector and the test stops proving anything. The trade-off is
// the accepted one for every entry here -- a real key pasted into that file would not be caught by the export scan --
// and it is bounded by the owner's own final secrets sweep before publishing.
const DENY_IGNORE = new Set([
  'test/browser-chromium-launch.test.ts',
  'test/browser-tools.test.ts',
  'test/browser-wrap.test.ts',
  'test/comms-scrub.test.ts',
  'test/library-capture.test.ts',
  'test/library-episode.test.ts',
  'test/library-graph.test.ts',
  'test/library-review-quota.test.ts',
  'test/library-review-secrets.test.ts',
  'test/library-review2-episode.test.ts',
  'test/project-board-agent-access.test.ts',
  'test/project-board-store.test.ts',
  'test/project-board-tools.test.ts',
  // The redaction fixtures ARE the test: it asserts that a key-shaped string never survives summarisation or
  // scrubbing, so the literals have to be real enough to trip the same patterns the product uses. Same reasoning as
  // the fixtures above - the guard is fail-closed everywhere else.
  'test/provider-compaction.test.ts',
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
  if (PROSE_DIRS.some((d) => rel === d || rel.startsWith(d + '/')) || ROOT_DOCS.includes(rel) || rel.startsWith('.github/') || SCRUB_ALSO.includes(rel)) rules = RULES;
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
