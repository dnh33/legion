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

/* ---- local mode screens (plan section 4) ---- */
import * as shared from '../src/shared/blender.js';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const run = <T>(code: string, ret: string, req: Record<string, unknown> = {}): T => {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('require', 'exports', `${js}\nreturn ${ret};`)((id: string) => req[id] ?? {}, {}) as T;
};
const cut = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  const b = to ? src.indexOf(to, a) : src.length;
  assert.ok(a >= 0 && b > a, `block ${from} found`);
  return src.slice(a, b).replace(/export /g, '');
};

type Copy = { MODE_CHOICES: Array<{ mode: string; title: string; text: string }>; showSocketNotice: (s: Record<string, unknown>) => boolean; visibleNotices: (s: Record<string, unknown>) => string[]; NOT_TRIED_VM: string; LOCAL_MODE_NOTE: string };
const copy = (): Copy => {
  const m = ts.transpileModule(read('ui/src/blender/copy.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exp: Record<string, unknown> = {};
  new Function('require', 'exports', m)((id: string) => (id.endsWith('shared/blender') ? shared : {}), exp);
  return exp as unknown as Copy;
};

test('"Where scripts run" offers four choices, recommended first, with the plain-language texts', () => {
  const c = copy().MODE_CHOICES;
  assert.deepEqual(c.map((x) => x.mode), ['auto', 'local', 'vm', 'live']);
  assert.deepEqual(c.map((x) => x.title), ['Automatic (recommended)', 'This computer, in the background', 'Cloud VM (boat.dev)', 'My open Blender']);
  assert.match(c[0]!.text, /^On this computer when Blender is found, otherwise in the cloud VM\. Your open Blender is used only when the Sculptor asks for it and you approve a LIVE card\.$/);
  assert.match(c[1]!.text, /runs with your Windows user.s rights/);
  assert.match(c[1]!.text, /filter, not a sandbox/);
  assert.match(c[2]!.text, /^Runs in the Sculptor.s VM, away from this computer.s files and accounts\. Needs a boat\.dev key and VM time\. Only exported files come back\.$/);
  const settings = read('ui/src/components/Settings.tsx');
  assert.match(settings, /MODE_CHOICES\.map/);
  assert.match(settings, /saveBlenderConfig\(\{ mode: c\.mode \}\)/);
  assert.match(settings, /Next script runs: /, 'the hint line');
  assert.doesNotMatch(settings, /Sandbox mode is unverified/);
});

test('the cloud VM note stays; the local path states what it does', () => {
  const c = copy();
  assert.match(c.NOT_TRIED_VM, /not yet tried on a real VM/);
  assert.match(c.LOCAL_MODE_NOTE, /runs scripts with your installed Blender/);
  assert.doesNotMatch(c.LOCAL_MODE_NOTE, /not yet tried/i);
  const settings = read('ui/src/components/Settings.tsx');
  assert.match(settings, /\{NOT_TRIED_VM\}/);
  assert.match(settings, /\{LOCAL_MODE_NOTE\}/);
});

test('the card view reads mode local, and the badge says "On this PC"', () => {
  const view = run<(a: unknown) => { mode: string; live: boolean }>(`${cut(SRC, 'export function blenderView', '/**\n * The same line breaks')}`, 'blenderView');
  const mk = (mode?: string) => ({ input: { script: 'x', ...(mode ? { mode } : {}) } });
  assert.equal(view(mk('local')).mode, 'local');
  assert.equal(view(mk('local')).live, false);
  assert.equal(view(mk('live')).mode, 'live');
  assert.equal(view(mk('sandbox')).mode, 'sandbox');
  assert.equal(view(mk()).mode, 'sandbox');
  assert.match(SRC, />On this PC</);
  assert.match(SRC, /v\.mode === 'local' && <div className="bl-live-warn">/);
  assert.match(SRC, /filter, not a sandbox|LOCAL_CARD_WARN/);
  assert.match(read('ui/src/blender/copy.ts'), /Runs headless Blender on this computer as you\. Read every line: Legion.s check is a filter, not a sandbox\./);
  assert.match(SRC, /<span><b>\{lines\.length\}<\/b> lines<\/span>/, 'the fixed line count (final line break not counted) is the number shown');
});

test('no key shortcut approves any Blender card, and the Blender card is not a one-key Allow', () => {
  const card = read('ui/src/components/ApprovalCard.tsx');
  // noKey covers the Blender script card (bl) AND the managed-download card; both are allowed by clicking only
  assert.match(card, /const noKey = bl \|\| a\.toolName === GET_BLENDER_TOOL \|\| a\.toolName === BLENDER_ASSET_TOOL;/);
  assert.match(card, /if \(!noKey && \(e\.key === 'a' \|\| e\.key === 'A'\)\)/);
  assert.match(card, /Allow\{!noKey && <> <kbd>A<\/kbd><\/>\}/);
  assert.match(card, /<BlenderBadge mode=\{bmode\} \/>/);
});

test('status lights: local ("Local ready") and busy ("Running a script"), VM called VM', () => {
  const lightLabel = run<(l: string) => { label: string; tone: string }>(cut(read('ui/src/blender/chipModel.ts'), 'export function lightLabel', ''), 'lightLabel');
  assert.deepEqual(lightLabel('local'), { label: 'Local ready', tone: 'on' });
  assert.deepEqual(lightLabel('busy'), { label: 'Running a script', tone: 'warn' });
  assert.equal(lightLabel('sandbox').label, 'VM ready');
  assert.equal(lightLabel('connected').label, 'Connected');
  const meta = read('ui/src/blender/BlenderCard.tsx');
  assert.match(meta, /Local: \{st\.localReady \? 'ready' : 'not found'\}/);
  assert.match(meta, /Cloud VM: /);
  assert.match(meta, /Live: \{live \?/);
});

test('the add-on socket notice shows only when the mode is live, or auto with a live backend reachable', () => {
  const c = copy();
  const base = { socketOpen: false, connected: false };
  assert.equal(c.showSocketNotice({ ...base, mode: 'live', sandbox: 'off' }), true);
  assert.equal(c.showSocketNotice({ ...base, mode: 'local', sandbox: 'auto' }), false);
  assert.equal(c.showSocketNotice({ ...base, mode: 'vm', sandbox: 'vm' }), false);
  assert.equal(c.showSocketNotice({ ...base, mode: 'auto', sandbox: 'auto' }), false, 'auto with nothing reachable');
  assert.equal(c.showSocketNotice({ ...base, mode: 'auto', sandbox: 'auto', socketOpen: true }), true);
  assert.equal(c.showSocketNotice({ ...base, mode: 'auto', sandbox: 'auto', connected: true }), true);
  assert.equal(c.showSocketNotice({ ...base, sandbox: 'off' }), true, 'an older core without mode: the legacy key decides');
  const notice = shared.BLENDER_SOCKET_NOTICE;
  const st = { ...base, mode: 'local', sandbox: 'auto', notices: [notice, 'Something else.'] };
  assert.deepEqual(c.visibleNotices(st), ['Something else.']);
  assert.deepEqual(c.visibleNotices({ ...st, mode: 'live', sandbox: 'off' }), [notice, 'Something else.']);
  assert.match(read('ui/src/blender/BlenderCard.tsx'), /visibleNotices\(st\)/);
  assert.match(read('ui/src/components/Settings.tsx'), /visibleNotices\(st\)/);
});
