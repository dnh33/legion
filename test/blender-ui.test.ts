/** S7: the approval card's line and hidden-character helpers. The UI file is TSX, so the pure helper block is cut out of the source and run for real. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { checkScript } from '../src/core/blender/static-check.js';

const SRC = readFileSync(join(process.cwd(), 'ui/src/blender/BlenderApproval.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'ui/src/blender/blender.css'), 'utf8');

function helpers() {
  const start = SRC.indexOf('export const splitScriptLines');
  const end = SRC.indexOf('export function BlenderBadge');
  assert.ok(start > 0 && end > start, 'helper block found');
  const code = SRC.slice(start, end).replace(/export /g, '');
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}\nreturn { splitScriptLines, lineParts, hiddenCount, hiddenLabel };`)() as {
    splitScriptLines: (s: string) => string[];
    lineParts: (l: string) => Array<string | { mark: string; bidi: boolean }>;
    hiddenCount: (s: string) => number;
    hiddenLabel: (c: string) => string;
  };
}

test('the card splits lines like Python and the checker: \\r\\n, a lone \\r and \\n each end a line', () => {
  const h = helpers();
  assert.deepEqual(h.splitScriptLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
  // the gutter number of a finding equals the card's line index + 1
  const script = 'import bpy\rimport os\nx = 1';
  const r = checkScript(script, { allowedDirs: [] });
  const finding = r.findings.find((f) => f.rule === 'import')!;
  assert.ok(finding);
  assert.equal(h.splitScriptLines(script)[finding.line - 1], 'import os');
});

test('a trailing line break does not add an empty numbered row, and finding numbers still match', () => {
  const h = helpers();
  assert.deepEqual(h.splitScriptLines('a\nb\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(h.splitScriptLines('a\r\nb\r\nc\r\n'), ['a', 'b', 'c']);
  assert.deepEqual(h.splitScriptLines('a\rb\r'), ['a', 'b']);
  assert.deepEqual(h.splitScriptLines('a\n\n'), ['a', '']); // a real blank last line is still shown
  assert.deepEqual(h.splitScriptLines('a'), ['a']);
  assert.deepEqual(h.splitScriptLines(''), ['']);
  assert.deepEqual(h.splitScriptLines('\n'), ['']);
  const script = 'import bpy\r\nimport os\r\nx = 1\r\n';
  const finding = checkScript(script, { allowedDirs: [] }).findings.find((f) => f.rule === 'import')!;
  assert.ok(finding);
  const lines = h.splitScriptLines(script);
  assert.equal(lines.length, 3);
  assert.equal(lines[finding.line - 1], 'import os');
});

test('hidden and bidirectional characters are shown as visible markers, bidi ones flagged', () => {
  const h = helpers();
  const parts = h.lineParts('a‮b​c');
  assert.deepEqual(parts, ['a', { mark: 'U+202E', bidi: true }, 'b', { mark: 'U+200B', bidi: false }, 'c']);
  assert.equal(h.hiddenCount('x⁦y­z﻿'), 3);
  assert.equal(h.hiddenCount('plain text'), 0);
  assert.deepEqual(h.lineParts('plain'), ['plain']);
});

test('the card labels the purpose as the bot\'s own text, wraps long lines, and warns about hidden characters', () => {
  assert.match(SRC, /The bot\{'’'\}s text, not checked/);
  assert.match(SRC, /hidden/i);
  assert.match(css, /overflow-wrap:\s*anywhere|word-break:\s*break-all|white-space:\s*pre-wrap/);
  assert.match(css, /\.bl-code\s*\{[^}]*white-space:\s*pre-wrap/, 'script rows wrap');
});
