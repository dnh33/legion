import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static properties of the one-line installers (scripts/install). They run for real in CI against the real latest release
// (see .github/workflows/ci.yml); these tests pin what must never change about their shape.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = (p: string): string => readFileSync(join(root, p), 'utf8');
const ps1 = raw('scripts/install/install.ps1').replace(/\r\n/g, '\n');
const sh = raw('scripts/install/install.sh');
const lastLine = (s: string): string => s.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '').pop() ?? '';

test('both installers end by calling their one function, so a cut-off download runs nothing', () => {
  assert.equal(lastLine(ps1), 'Install-Legion @args');
  assert.equal(lastLine(sh), 'main "$@"');
  assert.equal((ps1.match(/^Install-Legion @args/gm) ?? []).length, 1);
  assert.equal((sh.match(/^main "\$@"/gm) ?? []).length, 1);
  // nothing but comments, the function and (sh) tiny helper definitions before the call: no top-level command in install.ps1
  const topLevelPs1 = ps1.split('\n').filter((l) => l !== '' && !/^\s/.test(l) && !l.startsWith('#') && l.trimEnd() !== '}' && !l.startsWith('function Install-Legion {'));
  assert.deepEqual(topLevelPs1, ['Install-Legion @args']);
});

test('install.sh is POSIX sh with LF only', () => {
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(!sh.includes('\r'), 'no CR bytes');
  assert.match(sh, /^set -eu$/m);
  assert.doesNotMatch(sh, /^\s*sudo\s/m, 'never runs sudo');
});

test('the installers never use the GitHub API and only talk to dnh33/legion releases', () => {
  for (const s of [ps1, sh]) {
    assert.doesNotMatch(s, /api\.github\.com/);
    assert.match(s, /\/dnh33\/legion/);
  }
  assert.match(ps1, /\$repo = '\/dnh33\/legion\/releases'/);
  assert.match(ps1, /\$base = 'https:\/\/github\.com'/);
  assert.match(sh, /repo_path=\/dnh33\/legion/);
  assert.match(sh, /base=\$\{LEGION_INSTALL_BASE:-https:\/\/github\.com\}/);
  assert.match(ps1, /\$env:LEGION_INSTALL_BASE/);
  // every literal address in either script is on github.com or one of the docs pages it names
  for (const u of [...(ps1 + sh).matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0])) {
    assert.match(u, /^https:\/\/(github\.com|getlegion\.xyz|nodejs\.org|git-scm\.com)/, `unexpected address ${u}`);
  }
});

test('install.ps1 states the SHA-256 check honestly and never claims a signature', () => {
  assert.match(ps1, /checked against the release's SHA-256/);
  assert.match(ps1, /not code-signed/);
  assert.doesNotMatch(ps1, /\b(signed by|verified signature|trusted)\b/i);
  // the hash is compared before the zip is unpacked
  assert.ok(ps1.indexOf('Get-FileSha256 $zip') < ps1.indexOf('Expand-ZipSafe -Zip'));
  assert.match(ps1, /Nothing was unpacked or installed/);
});

test('install.ps1 does not use iex itself, and runs setup through a file with the policy bypassed', () => {
  const code = ps1.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\b(iex|Invoke-Expression)\b/i);
  assert.match(code, /'-ExecutionPolicy', 'Bypass', '-File', \$setup, '-Yes'/);
  assert.match(code, /\$ErrorActionPreference = 'Stop'/);
});
