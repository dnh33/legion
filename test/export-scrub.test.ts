import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walks the repo from dist/test/, so the checkout root is two levels up regardless of where the suite runs.
const REPO = fileURLToPath(new URL('../../', import.meta.url));

// The wallet port, built at runtime (never a literal — the port guard forbids it in code).
const PORT = String(Number('33' + '21'));
const PORT_RE = new RegExp('\\b' + PORT + '\\b');

// Everything the prose scrub must remove (mirrors the rules in scripts/export-public.mjs).
const PROSE_BANNED = [
  /[A-Za-z]:[\\/](?:Users|bots|Aetherkeep|dev|tmp|hermes)\b[^"'\s)]*/,
  /\/(?:opt|home|tmp|root|var)\b[^"'\s)]*/,
  /\bDaniel\b/,
  /(?:rune-vps|tailscale)/i,
  /session_[A-Za-z0-9_-]{6,}/,
  PORT_RE,
];

// Files that intentionally contain the wallet port and ship unchanged: the detection guardrails (scan/tripwire/
// guard/probe tests), the BSV knowledge-pack content (and the test that pins it), the perf-shot refusal guards,
// and the export script's own pattern source. Stripping these would gut the safety the owner demands.
const PORT_GUARDRAILS = new Set([
  'src/core/kg/seeds/bsv.json',
  'test/bsv-module-wallet.test.ts',
  'test/bsv-port-guard.test.ts',
  'test/bsv-review-tripwire.test.ts',
  'test/bsv-scan.ts',
  'test/bsv-spend-tripwire.test.ts',
  'test/bsv-wallet-probe.test.ts',
  'test/fixtures/bsv-pack-v7.json',
  'test/kg-bsv-seed.test.ts',
  'test-perf/bsv-ui/shots.mjs',
  'test-perf/ui-app/titlebar-shots.mjs',
  'scripts/export-public.mjs',
]);

const PROSE_ROOTS = ['claude', 'docs'];
const PROSE_FILES = new Set(['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'NOTICE', 'LICENSE', 'CLAUDE.md']);
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

test('export-public produces a scrubbed single-commit publishable snapshot', () => {
  const out = mkdtempSync(join(tmpdir(), 'legion-export-'));
  try {
    execFileSync(process.execPath, [join(REPO, 'scripts/export-public.mjs'), REPO, out], { stdio: 'pipe', timeout: 180_000 });

    // one commit, neutral identity, no history
    const identity = execFileSync('git', ['-C', out, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim();
    assert.equal(identity, 'Legion <legion@localhost>');
    const commits = execFileSync('git', ['-C', out, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(commits, '1');

    for (const f of walk(out)) {
      const rel = f.slice(out.length + 1).replace(/\\/g, '/');
      if (rel === 'scrub-report.json' || !TEXT_EXT.test(f)) continue;
      const text = readFileSync(f, 'utf8');
      if (isProse(rel)) {
        for (const re of PROSE_BANNED) {
          assert.ok(!re.test(text), `banned pattern ${re} survives in prose ${rel}`);
        }
      }
      if (PORT_RE.test(text)) {
        assert.ok(PORT_GUARDRAILS.has(rel), `wallet port literal outside the guardrail allowlist: ${rel}`);
      }
    }

    // exclusions
    for (const d of ['claude/skills', 'review', 'docs/video-v2/shots', 'node_modules', 'dist', 'dist-ui']) {
      assert.ok(!existsSync(join(out, d)), `${d} must not ship`);
    }
    // the snapshot carries its own .git; the outer check only skips the top-level one
    assert.ok(existsSync(join(out, '.git')), 'fresh git history expected in the snapshot');

    // required files
    for (const f of ['package.json', 'LICENSE', 'NOTICE', 'README.md', 'scripts/export-public.mjs', 'scrub-report.json']) {
      assert.ok(existsSync(join(out, f)), `${f} must ship`);
    }

    // the runtime guard VALUES are number-form, not literals
    const fw = readFileSync(join(out, 'scripts/harness/fake-wallet.mjs'), 'utf8');
    assert.ok(fw.includes("Number('33' + '21')"), 'harness fake wallet must build the port from number-form');
    assert.ok(!PORT_RE.test(fw), 'harness fake wallet must not carry the literal');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});