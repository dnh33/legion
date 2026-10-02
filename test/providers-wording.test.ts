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

test('C22 (pass 2) the shared hedge list and the "verified"/"safe" claims are absent from every file this feature adds or touches, and the CLI warning says what Legion cannot do', async () => {
  const { BANNED } = await import('./hedge-phrases.js');
  const { CLI_WARNING, ROOM_BUDGET_NOTE } = await import('../src/shared/providers-view.js');
  const files = [
    ...sources(join(repoRoot, 'src/core/providers')), ...sources(join(repoRoot, 'ui/src/providers')),
    join(repoRoot, 'src/electron/provider-ipc.ts'), join(repoRoot, 'src/shared/providers-view.ts'), join(repoRoot, 'ui/src/rooms/RoomHeader.tsx'),
    join(repoRoot, 'src/core/agent-tools.ts'), join(repoRoot, 'src/core/approvals.ts'),
  ];
  const CLAIM = /\b(?:is|are|stays?|makes? (?:it|them)) (?:safe|secure|verified|sandboxed)\b|\bverified\b|\bproven\b|\bsecure by\b|\bnothing (?:can|will) (?:leave|escape|reach)\b/i;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [why, re] of BANNED) assert.doesNotMatch(text, re, `${f}: ${why}`);
    // comments may say what a test proves; strings shown to the owner may not claim it
    const code = text.replace(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gm, '');
    const re = f.endsWith('.tsx') ? /'((?:[^'\\\n]|\\.){25,})'|`((?:[^`\\]|\\.){25,})`|(?<![=-])>([^<>{}=\n]{25,})</g : /'((?:[^'\\\n]|\\.){25,})'|`((?:[^`\\]|\\.){25,})`/g;
    const strings = [...code.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    for (const s of strings) assert.doesNotMatch(s, CLAIM, `${f}: "${s.slice(0, 80)}"`);
  }
  for (const t of [CLI_WARNING, ROOM_BUDGET_NOTE]) for (const [why, re] of BANNED) assert.doesNotMatch(t, re, why);
  assert.match(CLI_WARNING, /cannot see or stop its individual actions/);
  assert.match(CLI_WARNING, /outside Legion's per-tool approvals and taint tracking/);
  assert.match(CLI_WARNING, /promise, not a Legion control/);
  assert.match(CLI_WARNING, /Sign in to it yourself, outside Legion; Legion never reads or copies its login/);
});
