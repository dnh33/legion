/**
 * Wording check for the Blender screens, code strings and docs (plan section 4, control C22). The BSV hedge test only scans BSV files, so Blender text
 * was unprotected. Rules:
 *  1. The shared banned list (test/hedge-phrases.ts): guarantee, tamper-proof, cannot be bypassed, fully safe, ...
 *  2. (a) a sentence about local mode ("this computer", "on this PC", "local mode") that says "sandbox" must also say "not a sandbox" or "no sandbox";
 *     (b) such a sentence never calls local mode safe, secure, isolated or protected;
 *     (c) a claim about what Legion's runner stops or blocks names its scope ("Legion's own" runner or code, and "Python" or "script's code") and is
 *         followed, in the same or the next sentence, by a limit ("not", "only", "does not", "cannot").
 *  3. Required statements: "filter, not a sandbox", "your Windows user", and "not yet tried" until the real-Blender run is recorded in the tracker.
 * A self-test proves the rules catch the overclaims they exist for, and that adding one to a real source turns the scan red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from './bsv-scan.js';
import { BANNED } from './hedge-phrases.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const dirFiles = (rel: string, re: RegExp) => readdirSync(join(REPO, rel)).filter((n) => re.test(n)).map((n) => `${rel}/${n}`);

interface Src { name: string; text: string; code: boolean }

const blenderSection = (): string => {
  const t = read('ui/src/components/Settings.tsx');
  const a = t.indexOf('/* ---------------- Blender');
  const b = t.indexOf('function ConnectionsSection');
  assert.ok(a > 0 && b > a, 'Blender section of Settings.tsx found');
  return t.slice(a, b);
};
const mdLines = (rel: string, re: RegExp): string => read(rel).split('\n').filter((l) => re.test(l)).join('\n');

const SOURCES = (): Src[] => [
  ...dirFiles('ui/src/blender', /\.(tsx?|css)$/).map((f) => ({ name: f, text: read(f), code: /\.tsx?$/.test(f) })),
  { name: 'ui/src/components/Settings.tsx (Blender section)', text: blenderSection(), code: true },
  { name: 'src/shared/blender.ts', text: read('src/shared/blender.ts'), code: true },
  ...dirFiles('src/core/blender', /\.ts$/).map((f) => ({ name: f, text: read(f), code: true })),
  { name: 'docs/BLENDER.md', text: read('docs/BLENDER.md'), code: false },
  { name: 'SECURITY.md (Blender lines)', text: mdLines('SECURITY.md', /Blender/i), code: false },
  { name: 'CHANGELOG.md (Blender lines)', text: mdLines('CHANGELOG.md', /Blender/i), code: false },
];

/** What a person reads: in code, strings and JSX text with comments removed; in docs, the text. */
const MODE_VALUE = /^(sandbox|live|local|vm|auto|block|log)$/;
/**
 * Code: string literals and JSX text, each as its own line, AND the joined text of literals that are one sentence in the source:
 * "a " + "b" (concatenation) and a template literal with ${} in the middle. Judging only the halves let a split-up overclaim through.
 * Bare mode-value literals are identifiers, not prose.
 */
export function literals(src: string): string {
  const { kept, code } = lex(src);
  const out: string[] = [];
  const units: Array<{ text: string; s: number; e: number }> = [];
  const push = (raw: string) => {
    const t = raw.replace(/\\(['"`\\])/g, '$1').replace(/\s+/g, ' ').trim();
    if (t && !MODE_VALUE.test(t)) out.push(t);
  };
  let i = 0;
  // Walk code; at a quote read the literal, recursing into template ${...} so nested templates stay separate literals.
  const walk = (untilBrace: boolean): void => {
    let depth = 0;
    while (i < kept.length) {
      const c = kept[i]!;
      if (c === "'" || c === '"') {
        const s0 = i;
        let j = i + 1;
        while (j < kept.length && kept[j] !== c && kept[j] !== '\n') j += kept[j] === '\\' ? 2 : 1;
        const text = kept.slice(i + 1, j);
        push(text); units.push({ text, s: s0, e: j + 1 }); i = j + 1; continue;
      }
      if (c === '`') {
        const s0 = i;
        i++; let seg = '';
        const segs: string[] = [];
        while (i < kept.length && kept[i] !== '`') {
          if (kept[i] === '\\') { seg += kept.slice(i, i + 2); i += 2; continue; }
          if (kept[i] === '$' && kept[i + 1] === '{') { push(seg); segs.push(seg); seg = ''; i += 2; walk(true); continue; }
          seg += kept[i++];
        }
        push(seg); segs.push(seg); i++;
        if (segs.length > 1) push(segs.join(' '));
        units.push({ text: segs.join(' '), s: s0, e: i }); continue;
      }
      if (untilBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { i++; return; } depth--; } }
      i++;
    }
  };
  walk(false);
  // literals joined with + are one sentence
  units.sort((x, y) => x.s - y.s);
  let group: string[] = [];
  let end = -1;
  const flush = () => { if (group.length > 1) push(group.join('')); group = []; };
  for (const u of units) {
    if (group.length && u.s >= end && /^\s*\+\s*$/.test(kept.slice(end, u.s))) group.push(u.text); else { flush(); group = [u.text]; }
    end = u.e;
  }
  flush();
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) push(m[1]!);
  return out.join('\n');
}
const readable = (s: Src): string => (s.code ? literals(s.text) : s.text);
const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

const LOCALISH = /\blocal (mode|run|script|blender)|\bthis (computer|pc)\b|\bon this pc\b|\bheadless\b|\bin the background\b/i;
/** Words that name local mode itself (bare "this computer" and "headless" also appear in sentences about the VM: "away from this computer"). */
const STRONG_LOCAL = /\blocal (mode|run|script|blender)|\bin the background\b|\bon this (pc|computer)\b/i;
const VMISH = /\b(vm|cloud|boat\.dev|live blender|open blender|live card)\b/i;
const NOT_SANDBOX = /\b(not a sandbox|no sandbox|not sandboxed|is no sandbox)\b/i;
const POSITIVE = /(?<!\bnot )(?<!\bnot a )(?<!\bno )(?<!\bun)\b(safe|safely|secure|securely|isolated|protected)\b/i;
const SCOPE = /legion[’']?s (own|runner)/i;
const SCOPE2 = /\bpython\b|script[’']?s code/i;
const LIMIT = /\b(not|only|does not|doesn't|cannot|no)\b/i;
/** A claim about what Legion's runner or guard stops. */
const BLOCKS = /\b(runner|write guard|network guard)\b[^.]*\b(stops?|blocks?|prevents?|denies)\b|\b(stops?|blocks?|prevents?|denies)\b[^.]*\b(writing files|writes? (files )?outside|network connections?|sockets?)\b/i;
/** A sentence that only says what the thing does not do is not a claim. */
const NEGATED_ONLY = /\b(not|never|no) (a |an )?(stop|block|prevent|sandbox)/i;

export function scan(sources: Src[]): string[] {
  const hits: string[] = [];
  for (const s of sources) {
    for (const line of s.text.split('\n')) for (const [what, re] of BANNED) if (re.test(line)) hits.push(`${s.name}: ${what}: ${line.trim().slice(0, 160)}`);
    const ss = sentences(readable(s));
    ss.forEach((sent, i) => {
      // a sentence that names the VM is judged clause by clause: only a clause that is about the VM alone is exempt, "Unlike the cloud VM, local mode ... is a safe sandbox" is not
      for (const clause of sent.split(/[;,:]|\b(?:unlike|whereas|while)\b/i)) {
        const local = VMISH.test(clause) ? STRONG_LOCAL.test(clause) : LOCALISH.test(clause);
        if (local && /sandbox/i.test(clause) && !NOT_SANDBOX.test(clause)) hits.push(`${s.name}: (a) local text says sandbox without "not a sandbox": ${sent.slice(0, 160)}`);
        if (local && POSITIVE.test(clause)) hits.push(`${s.name}: (b) local text calls it safe/secure/isolated/protected: ${sent.slice(0, 160)}`);
      }
      if (BLOCKS.test(sent) && !NEGATED_ONLY.test(sent) && !VMISH.test(sent)) {
        const near = `${sent} ${ss[i + 1] ?? ''}`;
        if (!SCOPE.test(sent) || !SCOPE2.test(sent)) hits.push(`${s.name}: (c) a claim about what the runner blocks lacks its scope ("Legion's own ..." and "Python"/"script's code"): ${sent.slice(0, 160)}`);
        else if (!LIMIT.test(near.replace(sent.match(SCOPE)![0], ''))) hits.push(`${s.name}: (c) a claim about what the runner blocks has no limit next to it: ${sent.slice(0, 160)}`);
      }
    });
  }
  return hits;
}

const PC_RUN_RECORDED = (): boolean => /BLENDER LOCAL PC RUN RECORDED/.test(read('claude/tracker-pc-checks.md'));

test('blender hedge: no banned absolute and no unscoped claim in the Blender screens, strings and docs', () => {
  assert.deepEqual(scan(SOURCES()), []);
});

test('blender hedge: the required statements are present', () => {
  const ui = SOURCES().filter((s) => s.name.startsWith('ui/src/')).map(readable).join('\n');
  const docs = read('docs/BLENDER.md');
  for (const [name, text] of [['the UI copy', ui], ['docs/BLENDER.md', docs]] as const) {
    assert.match(text, /filter, not a sandbox/i, `${name} says "filter, not a sandbox"`);
    assert.match(text, /your Windows user|your user\b/i, `${name} says a local script runs with your user's rights`);
  }
  if (!PC_RUN_RECORDED()) {
    assert.match(ui, /not yet tried on a real VM/i, 'the UI keeps the cloud VM "not yet tried" note');
    assert.match(ui, /not yet tried with a real Blender on Windows/i, 'the UI keeps the local-mode "not yet tried" note');
    assert.match(docs, /not yet tried/i, 'docs/BLENDER.md keeps "not yet tried"');
    assert.match(mdLines('README.md', /Blender bridge/i), /not yet tried/i, 'README keeps the Blender "not yet tried" hedge');
  }
});

test('blender hedge: the rules catch the overclaims they exist for and pass the real wording', () => {
  const src = (text: string): Src => ({ name: 'sample', text, code: false });
  const bad = [
    'Local mode is sandboxed and safe.',
    'Scripts on this computer run in a sandbox.',
    'Headless Blender on this PC is isolated from your files.',
    'Local mode cannot be bypassed.',
    'The runner blocks writes outside the task folder.',
    "Legion's own runner stops Python code from writing files outside the task folder.",
    'Local scripts are 100% safe.',
  ];
  for (const t of bad) assert.ok(scan([src(t)]).length > 0, `should be caught: ${t}`);
  const good = [
    "On this computer a script runs with your Windows user's rights: Legion's check is a filter, not a sandbox.",
    "Legion's own runner also stops the script's Python code from writing files outside the task folder. It sees Python-level events only.",
    'The cloud VM is a sandbox away from this computer.',
    'Local mode is not yet tried with a real Blender on Windows.',
  ];
  for (const t of good) assert.deepEqual(scan([src(t)]), [], `should pass: ${t}`);
});

test('blender hedge: the scan judges prose, not code', () => {
  const code = (text: string): Src => ({ name: 'sample.ts', text, code: true });
  const bad = [
    "const label = 'Local mode is sandboxed and safe.';",
    "const msg = 'The runner blocks all network access.';",
    "const msg = 'Runs isolated on this computer.';",
    'export const C = () => <p>Local mode is sandboxed and safe.</p>;',
    // M4 review cases: H6 concatenation, H7 JSX text with ( ) ; =, H9 template with ${}
    "const m = 'Local mode runs on this computer ' + 'in a sandbox that is safe.';",
    'export const C = () => <p>Local mode on this computer is sandboxed (safe).</p>;',
    'export const C = () => <p>Local mode on this computer is a sandbox; it is safe = true.</p>;',
    'const m = `Local mode runs on this computer ${x} in a sandbox that is safe.`;',
    "const m = 'Local mode runs on this computer ' +\n  'in a sandbox that is safe.';",
  ];
  for (const t of bad) assert.ok(scan([code(t)]).length > 0, `should be caught in code: ${t}`);
  // M4 H10: naming the VM must not exempt a sentence that calls local mode a safe sandbox (docs and code)
  for (const t of ['Unlike the cloud VM, local mode on this computer is a safe sandbox.', 'The cloud VM is a sandbox and local mode on this computer is a sandbox too.']) {
    assert.ok(scan([{ name: 'sample.md', text: t, code: false }]).length > 0, `doc: ${t}`);
    assert.ok(scan([code(`const m = ${JSON.stringify(t)};`)]).length > 0, `code: ${t}`);
  }
  assert.ok(scan([{ name: 'sample.md', text: 'This cannot be bypassed.', code: false }]).length > 0, 'doc overclaim is caught');
  assert.ok(scan([{ name: 'sample.md', text: 'Runs isolated on this computer.', code: false }]).length > 0, 'doc "isolated" is caught');
  const good = [
    "if (want === 'sandbox' || want === 'live') return { error: 'Settings restrict scripts to Blender on this computer.' };",
    "const t = next.mode === 'local' ? 'Blender on this computer, in the background' : next.mode === 'sandbox' ? 'the cloud VM' : 'live';",
    "export function buildArgs(i: { runner: string; guard: 'block' | 'log'; mode: 'local' | 'vm' | 'auto' }): string[] { return []; }",
    `const note = "Legion's own runner stops the script's Python code from opening network connections; it is not a sandbox.";`,
  ];
  // sentences that are fine stay fine when split with + or a template, and a VM sentence that only says what local mode is not
  good.push(
    "const m = 'The cloud VM is a sandbox ' + 'away from this computer.';",
    "const m = 'Local mode on this computer is ' + 'not a sandbox.';",
    'const m = `Local mode on this computer is ${x} filter, not a sandbox.`;',
    'export const C = () => <p>Local mode (on this computer) is a filter, not a sandbox.</p>;',
  );
  for (const t of good) assert.deepEqual(scan([code(t)]), [], `should stay green: ${t}`);
  for (const t of ['The cloud VM is a sandbox, away from this computer.', 'Unlike local mode, which is not a sandbox, the cloud VM is a sandbox.', 'The cloud VM is a sandbox; local mode is not.']) assert.deepEqual(scan([{ name: 'sample.md', text: t, code: false }]), [], `doc should pass: ${t}`);
});

test('blender hedge: adding an overclaim to a real source turns the scan red', () => {
  const real = SOURCES();
  assert.deepEqual(scan(real), []);
  for (const [i, extra] of ['Local mode is sandboxed and safe.', 'The audit log cannot be bypassed.'].entries()) {
    const mutated = real.map((s) => (s.name === 'docs/BLENDER.md' ? { ...s, text: `${s.text}\n\n${extra}\n` } : s));
    assert.ok(scan(mutated).length > 0, `mutation ${i} is caught`);
  }
});
