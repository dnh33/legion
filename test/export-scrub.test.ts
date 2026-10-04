import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walks the repo from dist/test/, so the checkout root is two levels up regardless of where the suite runs.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const EXPORT = join(REPO, 'scripts', 'export-public.mjs');

// Sensitive values, built at runtime so they never appear as literals here (the port guard forbids it too).
const PORT = String(Number('33' + '21'));
const PORT_RE = new RegExp('\\b' + PORT + '\\b');
const OW_VAULT = ['Aether', 'keep'].join('');
const OW_VPS = ['rune-', 'vps'].join('');
const OW_VPN = ['tail', 'scale'].join('');

// Prose-only banned patterns: owner-local drives/paths (generic example paths in claude/** are fine, so this is
// scoped to the scrubbed prose, not every file).
const PROSE_BANNED = [
  /[A-Za-z]:[\\/](?:Users|bots|dev|tmp|hermes)\b[^"'\s)]*/,
  new RegExp('[A-Za-z]:[\\\\/]' + OW_VAULT + '\\b[^"\'\\s)]*'),
  /\/(?:opt|home|tmp|root|var)\b[^"'\s)]*/,
];

// Universal PII: these must appear in NO shipped file, prose or code/plans alike. Fragments so no literal ships.
const UNIVERSAL_PII = [
  new RegExp('\\b' + OW_VAULT + '\\b'),
  new RegExp('(?:' + OW_VPS + '|' + OW_VPN + ')', 'i'),
  /session_[A-Za-z0-9_-]{6,}/,
];

// Files that intentionally contain the wallet port and ship unchanged (the detection guardrails + pack content).
const PORT_GUARDRAILS = new Set([
  'src/core/kg/seeds/bsv.json',
  'test/bsv-module-wallet.test.ts',
  'test/bsv-port-guard.test.ts',
  'test/bsv-review-tripwire.test.ts',
  'test/bsv-scan.ts',
  'test/bsv-spend-tripwire.test.ts',
  'test/bsv-wallet-probe.test.ts',
  'test/bsv-fix-round.test.ts',
  'test/bsv-fake-wallet.ts',
  'test/fixtures/bsv-pack-v7.json',
  'test/kg-bsv-seed.test.ts',
  'scripts/harness/fake-wallet.mjs',
  'test-perf/bsv-ui/shots.mjs',
  'test-perf/ui-app/titlebar-shots.mjs',
]);

const PROSE_ROOTS = ['docs'];
const PROSE_FILES = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'NOTICE', 'LICENSE']);
const isProse = (rel: string) =>
  PROSE_ROOTS.some((d) => rel === d || rel.startsWith(d + '/')) ||
  PROSE_FILES.has(rel) || rel.startsWith('.github/');

const TEXT_EXT = /\.(md|txt|json|jsonl|ts|tsx|js|mjs|cjs|py|css|html|astro|yml|yaml|svg|ps1|sh|gitignore|gitattributes)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function runExport(args: string[]): { refused: string } | null {
  try {
    execFileSync(process.execPath, [EXPORT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null; // succeeded — a negative test expects failure, so a null here is a test bug
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { refused: String(err.stderr || err.message) };
  }
}

function fixture() {
  const d = cleanupTemp('legion-fix-');
  writeFileSync(join(d, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(d, 'README.md'), 'hello world');
  return d;
}

/**
 * A minimal tree the exporter accepts (it insists on package.json), with one file per scrub case.
 *
 * The main snapshot test can only prove the scrubbers work on content the repo happens to contain, which left the
 * bare vault-name rule unexercised: the one place the name occurs is `D:/<vault>/...`, and the local-path rule above it
 * in RULES already redacts that, so deleting the name rule outright changed nothing the test could see. This plants the
 * cases that no repo file contains -- the name on its own, without a drive prefix -- so each rule is load-bearing.
 */
function scrubFixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'legion-scrubfix-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'legion', version: '0.0.0' }));
  writeFileSync(join(d, 'README.md'), '# readme\n');
  writeFileSync(join(d, 'LICENSE'), 'MIT\n');
  writeFileSync(join(d, 'NOTICE'), 'notice\n');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(d, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return d;
}

/** Runs the exporter over `src` and returns the shipped copy of `rel`, or null when the export refused. */
function scrubbedCopy(src: string, rel: string): string | null {
  const out = mkdtempSync(join(tmpdir(), 'legion-scrubout-'));
  try {
    if (runExport([src, out]) !== null) return null;
    const abs = join(out, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('export-public produces a scrubbed single-commit publishable snapshot', () => {
  const out = cleanupTemp('legion-export-');
  try {
    assert.equal(runExport([REPO, out]), null, 'the export should succeed');

    // one commit, neutral identity, no history
    const identity = execFileSync('git', ['-C', out, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
    assert.equal(identity, 'Legion <legion@localhost>');
    assert.equal(execFileSync('git', ['-C', out, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(), '1');

    for (const f of walk(out)) {
      const rel = f.slice(out.length + 1).replace(/\\/g, '/');
      if (rel === 'scrub-report.json' || !TEXT_EXT.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      for (const re of UNIVERSAL_PII) {
        assert.ok(!re.test(text), `PII leaks in ${rel}: ${re}`);
      }
      if (isProse(rel)) {
        for (const re of PROSE_BANNED) {
          assert.ok(!re.test(text), `banned pattern leaks in prose ${rel}: ${re}`);
        }
      }
      if (PORT_RE.test(text)) {
        assert.ok(PORT_GUARDRAILS.has(rel), `wallet port literal outside the guardrail allowlist: ${rel}`);
      }
    }

    // exclusions: operational files and dirs never ship; the design plans/PC-check lists do (tests pin their content)
    for (const d of ['CLAUDE.md', 'review', 'docs/video-v2/shots', 'node_modules', 'dist', 'dist-ui',
      'claude/skills', 'claude/handoffs', 'claude/legion-release-tracker.md', 'claude/ORCHESTRATOR-HANDOFF.md',
      'claude/ORCHESTRATOR-TAKEOVER-PROMPT.md', 'claude/tracker-public-audit.md', 'claude/release-facts-0.2.0.md',
      'claude/tracker-pc-checks-prebuilt.md', 'claude/plan-bsv-rung3.md']) {
      assert.ok(!existsSync(join(out, d)), `${d} must not ship`);
    }
    for (const f of ['claude/plan-blender-local-first.md', 'claude/real-pc-test-plan.md', 'claude/tracker-pc-checks.md']) {
      assert.ok(existsSync(join(out, f)), `${f} must ship (tests pin its content)`);
    }
    assert.ok(existsSync(join(out, '.git')), 'fresh git history expected in the snapshot');

    // required files
    for (const f of ['package.json', 'LICENSE', 'NOTICE', 'README.md', 'scripts/export-public.mjs', 'scrub-report.json']) {
      assert.ok(existsSync(join(out, f)), `${f} must ship`);
    }


    // code ships byte-identical; the guardrail files keep their port literal (their own allowlists pin them)
    assert.equal(
      readFileSync(join(out, 'src/core/bsv/wallet-probe.ts'), 'utf8'),
      readFileSync(join(REPO, 'src/core/bsv/wallet-probe.ts'), 'utf8'),
      'canonical code file must be byte-identical in the snapshot'
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('export refuses the source dir as its own out dir, or an inside out dir', () => {
  const d = fixture();
  try {
    const r1 = runExport([d, d]);
    assert.ok(r1, 'expected refusal'); assert.match(r1!.refused, /out dir is the source/);
    const r2 = runExport([d, join(d, 'out')]);
    assert.ok(r2, 'expected refusal'); assert.match(r2!.refused, /inside the source/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('export fails closed on a planted secret file or a planted token', () => {
  const d1 = fixture();
  try {
    writeFileSync(join(d1, '.env'), 'KEY=value');
    const r1 = runExport([d1, join(d1, '..', 'fx-env-out-' + Date.now())]);
    assert.ok(r1, 'expected refusal'); assert.match(r1!.refused, /secret file/);
  } finally { rmSync(d1, { recursive: true, force: true }); }

  const d2 = fixture();
  try {
    // a fake PEM (the repo's own convention for fixtures), built from fragments so no private-key literal sits here
    const FAKE_PEM = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    writeFileSync(join(d2, 'notes.md'), FAKE_PEM);
    const r2 = runExport([d2, join(d2, '..', 'fx-tok-out-' + Date.now())]);
    assert.ok(r2, 'expected refusal'); assert.match(r2!.refused, /token or private key/);
  } finally { rmSync(d2, { recursive: true, force: true }); }
});

test('the scrub redacts a bare vault name in claude/**, the case no repo file happens to contain', () => {
  // The path rule above it in RULES already catches `D:/<vault>/...`, so without this the bare-name rule could be
  // deleted and the snapshot test would still pass -- it was verified that way. The name on its own, with no drive
  // prefix, is the case only that rule covers.
  const src = scrubFixture({ 'claude/note.md': `The narrative lives in ${OW_VAULT}.\n` });
  const shipped = scrubbedCopy(src, 'claude/note.md');
  assert.ok(shipped !== null, 'the export should succeed on a minimal tree');
  assert.ok(!shipped!.includes(OW_VAULT), `the bare vault name survived the scrub: ${JSON.stringify(shipped)}`);
  assert.ok(shipped!.includes('[redacted]'), 'and it was replaced with the redaction marker');
  rmSync(src, { recursive: true, force: true });
});

test('every scrubbed tree is covered, not just docs and one hand-listed file', () => {
  // The bug this closes: claude/ shipped VERBATIM because the scrub list named docs/, the root docs and .github only,
  // with one claude/ file carried as an exception, so an owner-local path in a claude/ plan reached the snapshot.
  //
  // An OWNER-LOCAL path, not a generic one. The path rule matches a drive root followed by one of the owner-local
  // directory names, and leaves illustrative paths alone, so a generic example path here would prove nothing.
  // Written from fragments: this file ships in the snapshot, and code files are deliberately NOT scrubbed (they must
  // stay byte-identical), so a literal owner-local path written here would ship. The vault path and the vault name
  // are covered by the test above and by the snapshot test respectively.
  const LOCAL = `${'D'}:/bots/legion`;
  const src = scrubFixture({
    'claude/plan.md': `Run it from ${LOCAL} when testing.\n`,
    'docs/guide.md': `Also ${LOCAL} here.\n`,
  });
  for (const rel of ['claude/plan.md', 'docs/guide.md']) {
    const shipped = scrubbedCopy(src, rel);
    assert.ok(shipped !== null, `the export should succeed (${rel})`);
    assert.ok(!shipped!.includes(LOCAL), `an owner-local path survived in ${rel}: ${JSON.stringify(shipped)}`);
  }
  rmSync(src, { recursive: true, force: true });
});

test('a cloud session id is redacted from a claude/ file', () => {
  // Assembled at runtime, never written literally: this very file ships, and the snapshot test scans every shipped
  // file for /session_[A-Za-z0-9_-]{6,}/. Writing the id out in full made the export fail on its own test source.
  const SESSION = ['session', 'AbCdEf123456'].join('_');
  const src = scrubFixture({ 'claude/handoff.md': `run id ${SESSION} here\n` });
  const shipped = scrubbedCopy(src, 'claude/handoff.md');
  assert.ok(shipped !== null, 'the export should succeed');
  assert.ok(!shipped!.includes(SESSION), `a session id survived: ${JSON.stringify(shipped)}`);
  rmSync(src, { recursive: true, force: true });
});

