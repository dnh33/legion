/**
 * Product copy guard: no development-state language in the desktop app's user-visible text.
 *
 * WHY THIS EXISTS
 * The shipped Providers screen told users the feature "has been built and tested against Legion's own fake
 * servers. It has not been tried against the real services yet". That is a note from the development process
 * leaking into a shipping product, and it is exactly the kind of text a person is not put off by in a hobby
 * project but is put off by in a product they are paying for. This test makes that whole class of leak fail
 * the build, so it cannot be reintroduced silently. (The skill rule that once MANDATED such disclaimers was
 * the source of the leak; it has been replaced. This guard is the mechanical replacement for it.)
 *
 * WHAT IT READS
 * Every .tsx file under ui/src, recursively. From each file it keeps only the text a person can actually read:
 *   1. JSX text nodes (`<p>this text</p>`);
 *   2. string literals and template literals that reach a render: JSX children (`{'text'}`) and the values of
 *      JSX attributes that are shown (title, placeholder, aria-label, a component's `label`/`hint` prop, ...);
 *   3. string arrays and object values (labels, menu items) and literals joined with `+`, since those are
 *      routinely mapped onto the screen.
 * It deliberately does NOT read: comments, test files, import paths, object/attribute names, CSS class names,
 * identifiers, console output, type literals or other non-visible code. Judging those would flag code, not copy.
 *
 * WHAT IT REJECTS
 * Development-status and hedging language a shipping product must not carry: "not tested", "tested against",
 * "fake/mock/stub server", "unverified"/"not verified", "has not been tried", "coming soon", "work in progress",
 * "for now", "TODO"/"FIXME"/"WIP", "hopefully", "we think", "might work", and "experimental" when it reads as a
 * hedge rather than the name of an experimental feature (see experimentalHedge below).
 *
 * THE HARD PART: not flagging legitimate copy. A guard that blocks a release over honest product text is worse
 * than no guard. So: comments, code and non-visible attributes are out of scope by construction (the AST is
 * asked, not a regex over raw bytes); "experimental" is allowed when it names the feature; and the self-test at
 * the bottom pins both directions (what must be caught, and what must stay green).
 *
 * SCOPE NOTE: this file scans .tsx only, on purpose. Some honest product copy lives in plain .ts modules
 * (ui/src/blender/copy.ts — now carrying only the cloud-VM "not yet tried" note, the local note having been
 * replaced with a statement of behaviour — and ui/src/graph/graphStore.ts). Scanning .ts blindly would flag
 * those reviewed statements; the provider .ts copy is covered by test/providers-wording.test.ts instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const UI_SRC = join(REPO, 'ui/src');
const rel = (p: string): string => relative(REPO, p).replace(/\\/g, '/');

/** Every .tsx under ui/src, recursively (the shipped UI), excluding test files. */
export function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

/**
 * JSX attributes whose string value is NOT shown to a person: class/id/appearance, wiring, payloads and
 * SVG geometry. A string value on any other attribute is treated as shown, so a component's custom text
 * prop (label, hint, ...) is covered without having to list every one of them. An attribute this list misses
 * only risks over-reading, never dropping real copy.
 */
const NON_VISIBLE_ATTRS = new Set([
  'className', 'class', 'id', 'key', 'role', 'style', 'ref', 'slot', 'part',
  'href', 'src', 'srcSet', 'poster', 'target', 'rel', 'action', 'method', 'form', 'htmlFor', 'for',
  'type', 'name', 'value', 'defaultValue', 'accept', 'multiple', 'capture', 'download', 'media', 'sizes',
  'autoComplete', 'spellCheck', 'inputMode', 'pattern', 'min', 'max', 'step', 'maxLength', 'minLength',
  'rows', 'cols', 'wrap', 'tabIndex', 'dir', 'lang', 'httpEquiv', 'charSet', 'contentType',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap',
  'strokeLinejoin', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points',
  'transform', 'offset', 'opacity', 'decode', 'loading', 'crossOrigin', 'referrerPolicy', 'as', 'color',
  'aria-hidden', 'aria-modal', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-disabled',
  'aria-busy', 'aria-controls', 'aria-owns', 'aria-haspopup', 'aria-current', 'aria-live', 'aria-atomic',
  'data-autofocus', 'autoFocus', 'dateTime', 'cite', 'scope', 'colSpan', 'rowSpan', 'headers',
]);

interface Piece { text: string; start: number }

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The JSX attribute a node's value sits in, looking through a `{...}` expression wrapper. */
function jsxAttrOf(node: ts.Node): ts.JsxAttribute | undefined {
  let p: ts.Node | undefined = node.parent;
  while (p && (ts.isJsxExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
  return p && ts.isJsxAttribute(p) ? p : undefined;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportEqualsDeclaration(p)) return true;
  if (ts.isImportTypeNode(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isCallExpression(p)) {
    if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(p.expression) && p.expression.text === 'require') return true;
  }
  return false;
}

/** console.log('...') and friends: development output, not product copy. */
function isConsoleOutput(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)
    && ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'console';
}

/** `{ 'key': ... }`, `switch (x) { case 'a': }`, a type union `'a' | 'b'`: names and types, not copy. */
function isNonCopyPosition(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
    || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p)
    || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === node) return true;
  if (ts.isLiteralTypeNode(p) || ts.isCaseClause(p) || ts.isComputedPropertyName(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  return false;
}

function isVisibleLiteral(node: ts.Node): boolean {
  if (isModuleSpecifier(node) || isConsoleOutput(node) || isNonCopyPosition(node)) return false;
  const attr = jsxAttrOf(node);
  if (attr) return !NON_VISIBLE_ATTRS.has(attr.name.getText());
  return true;
}

/** The text of a string / template literal, expressions in a template dropped (they are code). */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => ` ${s.literal.text}`).join('');
  }
  return undefined;
}

/** The literal text of a `a + b + c` chain, variables collapsed to a space, so a split phrase is read whole. */
function plusChain(node: ts.Node): string {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${plusChain(node.left)} ${plusChain(node.right)}`;
  }
  return literalText(node) ?? ' ';
}

/** All read-aloud text pieces of one source file. */
export function visiblePieces(src: string, fileName = 'sample.tsx'): Piece[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pieces: Piece[] = [];
  const push = (node: ts.Node, raw: string | undefined): void => {
    if (raw === undefined) return;
    const t = norm(raw);
    if (t && /[A-Za-z]/.test(t)) pieces.push({ text: t, start: node.getStart(sf) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      push(node, node.getText(sf));
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (isVisibleLiteral(node)) {
        push(node, literalText(node));
        // a `+` chain joins its parts into one sentence
        let top: ts.Node = node;
        while (top.parent && ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) top = top.parent;
        if (top !== node) push(top, plusChain(top));
      }
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // children of one element read as one line: `<p>It has not been{' '}tested against ...</p>`
      const parts: string[] = [];
      for (const child of node.children) {
        if (ts.isJsxText(child)) parts.push(child.getText(sf));
        else if (ts.isJsxExpression(child) && child.expression && (ts.isStringLiteral(child.expression) || ts.isNoSubstitutionTemplateLiteral(child.expression))) parts.push(child.expression.text);
      }
      if (parts.length > 1) push(node, parts.join(' '));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return pieces;
}

/** Development-state and hedge phrases a shipping product must not carry in user-visible text. */
const PHRASE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['a "not tested" development note', /\bnot (?:yet )?tested\b/i],
  ['a "tested against" development note', /\btested against\b/i],
  ['a fake/mock/stub server named in copy', /\b(?:fake|mock|stub) servers?\b/i],
  ['an "unverified" / "not verified" note', /\bunverified\b|\bnot (?:yet )?verified\b/i],
  ['a "not been tried/tested/verified" development note', /\b(?:has |have |had )?not been (?:tried|tested|verified)\b/i],
  ['a "not yet tried" development note', /\bnot yet (?:been )?tried\b/i],
  ['a "coming soon" placeholder', /\bcoming soon\b/i],
  ['a "work in progress" placeholder', /\bwork in progress\b/i],
  ['a "for now" placeholder', /\bfor now\b/i],
  ['a "TODO" developer marker', /\bTODO\b/],
  ['a "FIXME" developer marker', /\bFIXME\b/],
  ['a "WIP" developer marker', /\bWIP\b/],
  ['a "hopefully" hedge', /\bhopefully\b/i],
  ['a "we think" hedge', /\bwe think\b/i],
  ['a "might work" hedge', /\bmight work\b/i],
];

/**
 * "experimental" is only a leak when it is a hedge. When it names the feature (a badge, a preset) it is honest
 * product vocabulary and stays. A caveat or a copula around it ("is experimental", "still experimental",
 * "experimental and may change", "expect rough edges") is the hedge that fails. Absence of any such marker is
 * read as a feature name, so a neutral mention never blocks a release.
 */
const EXPERIMENTAL_CAVEAT = /\b(?:is|are|was|were|seems?|remains?|still|feels?|may|might|could|possibly|perhaps|tentative|unstable|incomplete|in progress|not (?:yet )?(?:stable|ready|finished|complete)|subject to change|can change|may change|might change|rough|early|preview|beta|placeholder|temporary|for now|under development|not finished)\b/i;
export function experimentalHedge(text: string): boolean {
  return /\bexperimental\b/i.test(text) && EXPERIMENTAL_CAVEAT.test(text);
}

/** Scan one source file's user-visible text; return one readable line per offending string. */
export function scanSource(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen = new Set<string>();
  const hits: string[] = [];
  const report = (start: number, text: string, reason: string): void => {
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    const key = `${line}:${reason}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(`${fileName}:${line}: ${reason}: "${text.slice(0, 160)}"`);
  };
  // visiblePieces parses the same source, so its positions map to the same lines as this source file.
  for (const piece of visiblePieces(src, fileName)) {
    for (const [reason, re] of PHRASE_RULES) if (re.test(piece.text)) report(piece.start, piece.text, reason);
    if (experimentalHedge(piece.text)) report(piece.start, piece.text, 'an "experimental" hedge');
  }
  return hits;
}

test('product copy: no development-state language in the desktop app UI text', () => {
  const files = tsxFiles(UI_SRC);
  assert.ok(files.length > 40, `the scan found the UI files (found ${files.length})`);
  const hits: string[] = [];
  for (const f of files) hits.push(...scanSource(rel(f), readFileSync(f, 'utf8')));
  assert.deepEqual(
    hits,
    [],
    `\nUser-visible text in the desktop app carries development-state or hedging language.\n` +
      `This is copy a shipping product must not show. Fix the wording in the file named below:\n  ` +
      hits.join('\n  '),
  );
});

test('product copy: the guard catches the leaks it exists for', () => {
  const bad = [
    // the exact sentence that shipped and started this work, proof the regression is caught
    `Provider support has been built and tested against Legion's own fake servers. It has not been tried against the real services yet.`,
    `<p>Provider support has been built and tested against Legion's own fake servers.</p>`,
    `<p>It has not been tried against the real services yet.</p>`,
    `const n = 'It has not been verified against a real service.';`,
    `const n2 = 'Local mode: not yet tried with a real Blender on Windows.';`,
    `<span>{'not tested'}</span>`,
    `<li>{'coming soon'}</li>`,
    `const x = ['work in progress'];`,
    `<p>This is experimental and may change.</p>`,
    `const h = 'It might work, hopefully.';`,
    'const t = `The endpoint is a mock server for now`;',
    `<p>Nothing we think is final.</p>`,
    `const m = 'Result: ' + 'TODO';`,
    `<p>Split across a brace: it has not been{' '}tested against a real backend.</p>`,
    `<label title="Not tested">Name</label>`,
  ];
  const badText = [
    'provider support has been tested against fake servers',
    'it has not been tried against the real services',
    'this is experimental and may change',
  ];
  bad.forEach((t) => assert.ok(scanSource('sample.tsx', `export const C = () => (${t});`).length > 0, `should be caught: ${t}`));
  badText.forEach((t) => assert.ok(scanSource('sample.tsx', `<p>${t}</p>`).length > 0, `should be caught: ${t}`));
});

test('product copy: honest product text and non-visible code stay green', () => {
  const good = [
    `<p>Credentials are sent only to the address you set here. If a request is rejected, the provider's own message is shown.</p>`,
    `<p>A continued task summarises older turns instead of keeping them verbatim.</p>`,
    `<li>{rep.stubs} stubs for unresolved titles</li>`,
    `const label = 'Experimental providers';`,
    `<button className="prov-experimental">Save</button>`,
    `/* it has not been tested against a fake server */`,
    `const clean = <p>Ready</p>;`,
    `console.log('not tested against a mock server');`,
    `import { x } from './not-tested-module.js';`,
    `<p>Last test accepted.</p>`,
    `<input placeholder="Type a command or agent name…" aria-label="Search" />`,
    `const urls = ['https://example.com/v1'];`,
  ];
  good.forEach((t) => assert.deepEqual(scanSource('sample.tsx', `export const C = () => (${t});`), [], `should stay green: ${t}`));
});

test('product copy: an experimental feature name passes, an experimental hedge fails', () => {
  assert.equal(experimentalHedge('Experimental providers'), false);
  assert.equal(experimentalHedge('Experimental mode'), false);
  assert.equal(experimentalHedge('This feature is experimental'), true);
  assert.equal(experimentalHedge('Provider support is still experimental and may change'), true);
  assert.equal(experimentalHedge('nothing experimental here'), false);
});

test('product copy: inserting a leak into a real UI file turns the scan red', () => {
  const file = join(UI_SRC, 'providers/ProvidersSection.tsx');
  const src = readFileSync(file, 'utf8');
  assert.deepEqual(scanSource('ui/src/providers/ProvidersSection.tsx', src), []);
  const mutated = src.replace('<h3>Providers</h3>', `<h3>Providers</h3><p>Built and tested against fake servers.</p>`);
  assert.notEqual(mutated, src, 'the mutation point exists');
  assert.ok(scanSource('ui/src/providers/ProvidersSection.tsx', mutated).length > 0, 'the planted leak is caught');
});
