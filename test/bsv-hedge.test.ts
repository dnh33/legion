/**
 * Fix round, item 2: the BSV panel, dialogs, agent text and docs must not claim guarantees the code does not give.
 * This is the hedge check for the places a person reads (the pack has its own in bsv-review-pack.test.ts). Two rules:
 *  1. A banned phrase list: absolutes that came from real review findings or that nothing in Legion can back (a guarantee, "tamper-proof",
 *     "nothing can proceed", "could ever receive", "can no longer flip the switch").
 *  2. A universal negative about moving funds ("nothing signs", "never spends", "cannot send") must carry its scope in the same sentence:
 *     it is a statement about LEGION'S OWN code and tools in this version, not about an agent's ordinary tools (a shell, a web fetch).
 * And three statements must be present, because leaving them out would be the overclaim: the panel and the docs say the agent's ordinary tools
 * are outside what Legion controls, that the wallet's own prompt is the real last gate, and that nothing was verified against a real wallet.
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

/** The BSV section of a long document: from the first heading or paragraph that names BSV to the next heading of the same or a higher level. */
const securityBsv = (): string => read('SECURITY.md').split('\n').filter((l) => /BSV|wallet|Wallet/.test(l)).join('\n');

const SOURCES: Array<{ name: string; text: string }> = [
  ...dirFiles('ui/src/bsv', /\.(tsx?|css)$/).map((f) => ({ name: f, text: read(f) })),
  ...dirFiles('src/shared', /^bsv-.*\.ts$/).map((f) => ({ name: f, text: read(f) })),
  ...dirFiles('src/core/bsv', /\.ts$/).map((f) => ({ name: f, text: read(f) })),
  { name: 'src/electron/admin-logic.ts', text: read('src/electron/admin-logic.ts') },
  { name: 'docs/BSV-MODE.md', text: read('docs/BSV-MODE.md') },
  { name: 'docs/BSV-WALLET-DESIGN.md', text: read('docs/BSV-WALLET-DESIGN.md') },
  { name: 'SECURITY.md (the lines about BSV and the wallet)', text: securityBsv() },
  { name: 'CHANGELOG.md (the lines about BSV)', text: read('CHANGELOG.md').split('\n').filter((l) => /BSV|wallet/i.test(l)).join('\n') },
];

const NEG = /\b(nothing|no one|nobody|never|cannot|can't|can not|impossible|no way|none)\b/i;
const VERB = /\b(sign|signs|signed|signing|spend|spends|spending|send|sends|sent|broadcast\w*|move funds|touch funds|holds? (your )?funds|inscribe\w*)\b/i;
/** What scopes a universal negative: it is about Legion's own code or tools, in this version, or it is hypothetical. */
const SCOPE = /(legion'?s? (own|code|tools?|app)|no spend tool|this version|this release|a later version|later version|not yet|\byet\b|design|\bwould\b|ordinary tools|\bshell\b)/i;

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n/);

test('hedge: no banned absolute appears in the BSV panel, dialogs, agent text or docs', () => {
  const hits: string[] = [];
  for (const s of SOURCES) for (const line of s.text.split('\n')) for (const [what, re] of BANNED) if (re.test(line)) hits.push(`${s.name}: ${what}: ${line.trim().slice(0, 160)}`);
  assert.deepEqual(hits, []);
});

/** What a person reads: in code, the strings and the JSX text (comments are notes to maintainers, and are covered by the banned list above). */
const readable = (s: { name: string; text: string }): string => (/\.(tsx?)$/.test(s.name) ? lex(s.text).kept : s.text);

test('hedge: a universal negative about signing, spending or sending says whose code it is about (Legion\'s own, in this version)', () => {
  const hits: string[] = [];
  for (const s of SOURCES) for (const sent of sentences(readable(s))) if (NEG.test(sent) && VERB.test(sent) && !SCOPE.test(sent)) hits.push(`${s.name}: ${sent.trim().slice(0, 200)}`);
  assert.deepEqual(hits, []);
});

test('hedge: the panel, the dialogs and the docs say what the guarantee does not cover', () => {
  const panel = SOURCES.filter((s) => s.name.startsWith('ui/src/bsv/')).map((s) => s.text).join('\n');
  const mode = read('docs/BSV-MODE.md');
  const dialogs = read('src/electron/admin-logic.ts');
  // the agent's ordinary tools are outside what Legion's own code controls
  assert.match(panel, /ordinary tools/i, 'the panel names the agent\'s ordinary tools');
  assert.match(dialogs, /ordinary tools/i, 'the dialogs name the agent\'s ordinary tools');
  assert.match(mode, /ordinary tools[^.]*(shell|web)/i, 'BSV-MODE.md says a shell or web tool is outside the guarantee');
  assert.match(mode, /wallet'?s own (prompt|confirmation)/i, 'BSV-MODE.md names the wallet prompt as the real last gate');
  assert.match(mode, /never (been )?(pointed|talked)[^.]*real/i, 'BSV-MODE.md says the real wallet was never contacted');
  // a freeze is described as stopping Legion's BSV tools, not everything
  const view = read('src/shared/bsv-view.ts');
  assert.doesNotMatch(view, /nothing can proceed/i);
  assert.match(view, /BSV FROZEN/);
});

test('hedge: the check itself catches the phrases it exists for', () => {
  const bad = ['Nothing in Legion signs, sends or holds funds.', 'The audit log is tamper-proof.', 'It guarantees that no spend happens.', 'BSV FROZEN: nothing can proceed', 'Only addresses on this list could ever receive a payment.', 'so a bot with a shell can no longer flip the switch'];
  for (const t of bad) assert.ok(BANNED.some(([, re]) => re.test(t)) || (NEG.test(t) && VERB.test(t) && !SCOPE.test(t)), t);
  const good = ['It is tamper-evident, not tamper-proof.', "Legion's own code has no way to sign or send in this version.", 'Legion has no spend tool in this version.'];
  for (const t of good) assert.ok(!BANNED.some(([, re]) => re.test(t)) && !(NEG.test(t) && VERB.test(t) && !SCOPE.test(t)), t);
});
