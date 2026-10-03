import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_PRESETS } from '../src/core/providers/presets.js';
import { PROVIDER_LIMITS_TEXT } from '../src/core/providers/runtime.js';
import { repoRoot } from './ps-helpers.js';

/** Claims Legion does not get to make about a provider: only the owner's own real-key check can show them. */
const OVERCLAIM = /\b(?:fully (?:safe|supported|compatible)|guaranteed|verified (?:with|against|on)|tested (?:with|against) (?:the )?real|works with (?:openai|openrouter|codex|opencode|ollama)|officially supported|cannot be bypassed|100% )/i;

function* sources(dir: string): Generator<string> {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) yield* sources(p); else if (/\.(ts|tsx|css)$/.test(n.name)) yield p;
  }
}

test('C22 the user-facing provider text carries no verification or safety overclaim', () => {
  const texts = [...PROVIDER_PRESETS.map((p) => p.note), ...PROVIDER_LIMITS_TEXT];
  for (const t of texts) assert.doesNotMatch(t, OVERCLAIM, t);
  const files = [...sources(join(repoRoot, 'src/core/providers'))];
  const ui = join(repoRoot, 'ui/src/providers');
  if (existsSync(ui)) files.push(...sources(ui));
  assert.ok(files.length >= 8);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), OVERCLAIM, f);
});

test('C22 the plan and the real-key checks list say nothing is verified yet', () => {
  const checks = join(repoRoot, 'claude/tracker-pc-checks-providers.md');
  if (!existsSync(checks)) return;
  const t = readFileSync(checks, 'utf8');
  assert.match(t, /not (?:yet )?(?:tried|verified)|no check .* passed|todo/i);
  assert.doesNotMatch(t, /\|\s*pass\s*\|/i);
});
