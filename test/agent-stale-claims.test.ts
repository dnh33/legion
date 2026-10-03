/**
 * Stale-claims scan, scoped to what a bot or a reader is told: personas, the shared preamble, module preambles, tool descriptions,
 * the BSV lesson pack, and the README/ARCHITECTURE/BSV-MODE lines. Each banned phrase names the files it is checked in; a legitimate
 * use goes in `allow` with the exact line, never by loosening the phrase. Add a phrase when a claim stops being true.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string): string => readFileSync(REPO + p, 'utf8');

const PROMPT_FILES = [
  'src/core/roster.ts', 'src/core/engine.ts', 'src/core/store.ts', 'src/core/agent-facts.ts', 'src/core/agent-tools.ts', 'src/core/mcp-tools.ts',
  'src/core/kg/index.ts', 'src/core/kg/tools.ts', 'src/core/comms/tools.ts', 'src/core/bsv/index.ts', 'src/core/bsv/wallet-tool.ts', 'src/core/bsv/spend.ts',
  'src/core/blender/index.ts', 'src/core/browser/tools.ts',
];
const DOC_FILES = ['README.md', 'docs/ARCHITECTURE.md', 'docs/BSV-MODE.md'];
const SEED = ['src/core/kg/seeds/bsv.json'];

interface Banned { re: RegExp; files: string[]; why: string; allow?: string[] }
export const BANNED: Banned[] = [
  { re: /no spend tool|has no tool that signs|Not built: [^.\n]*spend tool|planned, not built/i, files: [...PROMPT_FILES, ...DOC_FILES, ...SEED], why: 'the BSV spend tool is built (bsv_spend_request)' },
  { re: /sandbox VM by default|scripts run in the sandbox/i, files: [...PROMPT_FILES, ...DOC_FILES], why: 'Blender runs on this computer by default when found; local is a filter, not a sandbox' },
  { re: /inside its VM/i, files: [...PROMPT_FILES, ...DOC_FILES], why: 'Blender is local-first' },
  { re: /mainnet only when the user (explicitly )?asks/i, files: [...PROMPT_FILES, ...DOC_FILES, ...SEED], why: 'a bot never chooses the network; mainnet is hard-off and the owner enables it' },
  { re: /Lightpanda|small text-only browser|partial JavaScript support/i, files: [...PROMPT_FILES, ...DOC_FILES], why: 'the browser tool has one engine: the Edge or Chrome on the PC' },
  { re: /nine tools|VM required|requires a VM/i, files: [...PROMPT_FILES, ...DOC_FILES], why: 'old counts and requirements' },
  { re: /cannot be bypassed|fully safe|guaranteed safe/i, files: [...PROMPT_FILES, ...DOC_FILES], why: 'claims are scoped, never absolute' },
];

test('stale claims: no banned phrase appears in a prompt, tool description, lesson pack or doc line', () => {
  const bad: string[] = [];
  for (const b of BANNED) {
    for (const f of b.files) {
      read(f).split('\n').forEach((line, i) => {
        if (b.re.test(line) && !(b.allow ?? []).includes(line.trim())) bad.push(`${f}:${i + 1} [${b.why}] ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.deepEqual(bad, []);
});

test('stale claims negative: the scan catches each banned phrase', () => {
  const samples = ['There is no spend tool in this version.', 'Scripts run in the sandbox VM by default', 'headless Blender inside its VM', 'mainnet only when the user explicitly asks.', 'a small text-only browser', 'Lightpanda runs it', 'VM required'];
  for (const s of samples) assert.ok(BANNED.some((b) => b.re.test(s)), `not caught: ${s}`);
});
