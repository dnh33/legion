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
  const d = mkdtempSync(join(tmpdir(), 'legion-fix-'));
  writeFileSync(join(d, 'package.json'), '{"name":"fixture"}');
  writeFileSync(join(d, 'README.md'), 'hello world');
  return d;
}

test('export-public produces a scrubbed single-commit publishable snapshot', () => {
  const out = mkdtempSync(join(tmpdir(), 'legion-export-'));
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
