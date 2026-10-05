/**
 * The approval cards as a person reads them (art review 2026-10-05, claude/art-review/cards/).
 *
 *  - The head names the bot that asks (a.agentId). The origin line names the bot or client whose message started the run, as "Via ...":
 *    before, a card in a room said "Asked by Zealot" above "Builder asks to add Scout", naming the wrong bot as the asker.
 *  - Nothing a person must read sits below a fold: at 560 px the room-create card hid its last line ("Only you can delete the room
 *    later. Deny to stop it.") behind a 160 px cap. The core caps every summary, so the box has no height cap.
 *  - Colours come from tokens: the card borders used the dark theme's yellow and red in the light theme too.
 *  - The Blender mode chooser on the first card has no filled (primary) button competing with Allow.
 *  - BSV: every spend request row says its network; a missing or odd value reads "Network unknown", never testnet.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const rule = (css: string, sel: string): string => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `rule ${sel}`);
  return css.slice(i, css.indexOf('}', i));
};

test('the head names the asking bot; the origin line says who started the run, as Via, never "Asked by"', () => {
  const card = read('ui/src/components/ApprovalCard.tsx');
  assert.match(card, /const who = useStore\(\(s\) => \(askedByYou \? 'You, from Settings' : s\.agents\.find\(\(x\) => x\.id === a\.agentId\)\?\.name \?\? a\.agentId\)\);/);
  assert.match(card, /<span className="approval-who">\{who\}<\/span>/);
  // the Blender download is the owner's own request from Settings: the card must not name the Sculptor as the asker
  assert.match(card, /const askedByYou = a\.toolName === GET_BLENDER_TOOL;/);
  assert.match(card, /askedByYou \? 'You, from Settings' :/);
  assert.match(card, /Via <b>\{from\}<\/b> in <b>/);
  assert.match(card, /Via <b>an MCP client<\/b>/);
  assert.doesNotMatch(card, /Asked by/);
  // click-only cards say why there is no A
  assert.match(card, /\{noKey && <span className="approval-click">No shortcut allows this: read it, then press Allow\. <\/span>\}Auto-denies after 10 min/);
});

test('no fold, no wash, no theme-blind colour on the card', () => {
  const app = read('ui/src/styles/app.css');
  const bl = read('ui/src/blender/blender.css');
  assert.doesNotMatch(rule(app, '.approval-sum'), /max-height/, 'nothing a person must read hides below a fold');
  assert.doesNotMatch(rule(app, '.approval'), /gradient/);
  const cardRules = [...app.matchAll(/^\.approval[^{]*\{[^}]*\}/gm), ...bl.matchAll(/^\.(approval|bl-(badge|facts|purpose|script|hid|notes|live-warn|chooser|note|notices))[^{]*\{[^}]*\}/gm)].map((m) => m[0]);
  assert.ok(cardRules.length > 12);
  for (const r of cardRules) {
    assert.doesNotMatch(r, /rgba\(|#[0-9a-f]{3,8}\b/i, `a raw colour in: ${r.slice(0, 80)}`);
    assert.doesNotMatch(r, /linear-gradient/, r.slice(0, 80));
  }
  const tokens = read('ui/src/styles/tokens.css');
  assert.equal((tokens.match(/--warn-line:/g) ?? []).length, 2, 'both themes');
  assert.equal((tokens.match(/--danger-line:/g) ?? []).length, 2, 'both themes');
  // risk keeps its colour: Live and On this PC are danger, the head turns danger too
  assert.match(rule(bl, '.bl-badge.local'), /color: var\(--danger\)/);
  assert.match(bl, /\.approval\.is-risky \.approval-ask/);
});

test('the one-time Blender chooser offers choices without a primary button', () => {
  const c = read('ui/src/blender/ModeChooser.tsx');
  assert.doesNotMatch(c, /primary/);
  assert.match(c, /' suggested'/);
});

function netMark(): (p: { net: unknown }) => { text: string; net: string } {
  const src = read('ui/src/bsv/BsvPanel.tsx');
  const start = src.indexOf('function NetMark');
  const end = src.indexOf('function SpendSection');
  assert.ok(start > 0 && end > start, 'NetMark found');
  const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const React = { createElement: (_t: string, props: Record<string, string>, ...kids: string[]) => ({ text: kids.join(''), net: props['data-net'] }) };
  return new Function('React', `${js}\nreturn NetMark;`)(React);
}

test('BSV: each spend request row says its network, and an absent or odd value never reads as testnet', () => {
  const m = netMark();
  assert.deepEqual(m({ net: 'main' }), { text: 'Mainnet', net: 'main' });
  assert.deepEqual(m({ net: 'mainnet' }), { text: 'Mainnet', net: 'main' });
  assert.deepEqual(m({ net: 'test' }), { text: 'Testnet', net: 'test' });
  for (const odd of [undefined, null, '', 'invalid', 'MAIN', 1]) assert.deepEqual(m({ net: odd }), { text: 'Network unknown', net: 'none' }, String(odd));
  const panel = read('ui/src/bsv/BsvPanel.tsx');
  const spend = panel.slice(panel.indexOf('function SpendSection'), panel.indexOf('function LimitsSection'));
  assert.match(spend, /<NetMark net=\{p\.pending\.find\(\(x\) => x\.requestId === r\.requestId\)\?\.network\} \/>/);
  assert.match(spend, /<NetMark net=\{p\.unknown\.find\(\(x\) => x\.requestId === r\.requestId\)\?\.net\} \/>/);
});
