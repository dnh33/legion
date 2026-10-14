/** Source guards for the project page (no DOM runner): mint only where the spec allows it, copy rules, names on buttons, one send path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pageDir = join(root, 'ui', 'src', 'projects', 'page');
const read = (f: string): string => readFileSync(join(pageDir, f), 'utf8');
const files = readdirSync(pageDir).filter((f) => /\.(tsx?|css)$/.test(f));

/** Rules of a stylesheet as [selector, body]. Flat enough for this file: no nested rules except @media/@container blocks, which are flattened. */
function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) out.push([m[1]!.trim().replace(/^@[^{]*$/, ''), m[2]!]);
  return out.filter(([s]) => s);
}

test('mint (accent, live) only on New task, live dots, the live status icon and the live group; never on Allow, tabs, switches or the focus ring', () => {
  const allowed = [/\.pg-btn\.primary/, /\.pg-ws h2::before/, /\.pg-grp\.live h2::before/, /\.pg-st\.live/, /\.pg-dot/, /\.pg-chip\.working i/];
  for (const [sel, body] of rules(read('page.css'))) {
    if (!/var\(--(accent|live)/.test(body)) continue;
    assert.ok(allowed.some((a) => a.test(sel)), `mint used on: ${sel}`);
  }
  const css = read('page.css');
  assert.match(css, /\.pg-tabs button\[aria-selected=true\]::after \{[^}]*background: var\(--text\)/, 'the tab underline is neutral');
  assert.match(css, /\.pg-btn\.strong \{[^}]*border-color: var\(--text-2\)/, 'Allow is neutral');
});

test('every focus ring sits under keyboard navigation', () => {
  for (const [sel] of rules(read('page.css'))) if (/:focus-visible/.test(sel)) assert.match(sel, /data-kbd-nav/, sel);
});

test('copy rules: no em or en dash, never "this computer" or "this machine", no outside product names', () => {
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /[–—]/, `${f}: dash`);
    assert.doesNotMatch(src, /this computer|this machine/i, f);
    assert.doesNotMatch(src, /(Hermes|Shipyard|Cursor)/, f);
  }
});

test('every digest button is named with the agent and the item; Deny and Reject are never held', () => {
  const ask = read('askLogic.ts');
  assert.match(ask, /aria: `\$\{b\.label\}: \$\{who\} \$\{item\}`/);
  assert.match(ask, /act: 'deny', label: 'Deny'[^}]*held: false/);
  assert.match(ask, /act: 'reject', label: 'Reject'[^}]*held: false/);
  const digest = read('Digest.tsx');
  assert.match(digest, /aria-label=\{b\.aria\}/);
  assert.match(digest, /aria-label=\{`Undo: /);
  assert.match(digest, /aria-label=\{`Send now: /);
});

test('the only code that answers a card from the page is answerActions (one send path), and the hold decides when', () => {
  for (const f of files.filter((n) => /\.tsx?$/.test(n) && n !== 'answerActions.ts')) {
    assert.doesNotMatch(read(f), /api\.(decide|answerQuestion)\(/, `${f} must not answer a card itself`);
  }
  const store = read('answerStore.ts');
  assert.match(store, /createHold\(/);
  assert.match(store, /if \(!b\.held\)/, 'only an answer that is not held (Deny, Reject) goes out at once');
  assert.match(store, /Math\.min\(300, now - last\)/, 'a throttled timer cannot run a countdown out unseen');
  assert.match(store, /document\.hidden/);
});

test('the page keeps its state in memory only: no new localStorage key', () => {
  for (const f of files.filter((n) => /\.tsx?$/.test(n))) assert.doesNotMatch(read(f), /localStorage|sessionStorage/, f);
});

test('regions are named for the layouts work', () => {
  const all = files.filter((f) => /\.tsx$/.test(f)).map(read).join('\n');
  for (const r of ['banner', 'working', 'digest', 'body', 'side']) assert.ok(all.includes(`data-region="${r}"`), r);
});

test('review fixes: one proposal source for switcher and rail, a picker for 2+ members, the agent panel closed on the page, Take out on archived, the viewing note', () => {
  const ui = join(root, 'ui', 'src');
  assert.match(readFileSync(join(ui, 'projects', 'ProjectSwitcher.tsx'), 'utf8'), /useAllProposals\(\)[\s\S]*deriveAsks\(\{[^}]*proposals/);
  const rail = readFileSync(join(ui, 'components', 'AgentRail.tsx'), 'utf8');
  assert.match(rail, /waitingElsewhere\([^)]*proposals\)/);
  assert.match(rail, /board: \{ items: \[\], inbox: proposals \}/);
  const frame = read('ProjectPage.tsx');
  assert.doesNotMatch(frame, /Agent for the new task/, 'the old To: select is replaced by the New task sheet pills');
  assert.match(read('Sheet.tsx'), /Best fit/);
  assert.match(readFileSync(join(ui, 'App.tsx'), 'utf8'), /opsOpenPref && view !== 'project'/);
  assert.doesNotMatch(read('TabsContent.tsx'), /disabled=\{busy \|\| archived\}/);
  assert.match(read('Overview.tsx'), /Viewing \{projectLabel\(project\)\}/);
  assert.match(readFileSync(join(ui, 'App.tsx'), 'utf8'), /<HoldChip \/>/);
});
