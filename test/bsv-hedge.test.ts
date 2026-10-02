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

// ---------------------------------------------------------------- rung 3: the spend tool exists, mainnet is built and OFF, nothing is verified with a real wallet (T4)

/** BSV-only absolutes (not in the shared list, which the Blender text also uses). */
const BSV_BANNED: Array<[string, RegExp]> = [
  ['"risk-free"', /\brisk[- ]free\b/i],
  ['"cannot lose" / "can\'t lose"', /\b(cannot|can'?t) lose\b/i],
  ['"no way to overspend"', /\bno way to overspend\b/i],
  ['"safe to spend"', /\bsafe to spend\b/i],
  ['"safe on mainnet"', /\bsafe on mainnet\b/i],
  ['"production-ready"', /\bproduction[- ]ready\b/i],
];
/** Claims that were true before the spend tool existed and are false now. Each must be gone from every scanned source. */
const STALE: Array<[string, RegExp]> = [
  ['"has no spend tool" / "no spend tool exists"', /\b(has|have) no spend tool\b|\bno spend tool (exists|yet|in this version)\b|\bthere is no spend tool\b/i],
  ['"testnet only" about what Legion does', /\b(legion|bsv mode)\b[^.]{0,60}\btestnet[- ]only\b|\btestnet[- ]only in (v1|this version)\b/i],
  ['"refuses mainnet" (it refuses it unless switched on and armed)', /\brefuses (a )?mainnet\b/i],
  ['"mainnet is not designed" / "mainnet is out of reach"', /\bmainnet (is|stays) (not designed|out of reach|out of v1)\b/i],
  ['"policy state that nothing consumes"', /\b(nothing consumes|nothing calls it|connected to (no tool|nothing)|policy state and nothing else)\b/i],
];
/** "verified with real funds" is banned until the owner's record exists; the record is one line in the PC checks file. */
const REAL_FUNDS_RECORD = /^BSV REAL-FUNDS CHECK RECORDED\b/m;
const realFundsRecorded = (): boolean => REAL_FUNDS_RECORD.test(read('claude/tracker-pc-checks.md'));
const VERIFIED_CLAIM = /\b(verified|tested|checked|proven) (with|against|on) (a )?(real|live|mainnet|funded)[^.]{0,30}(funds|wallet|money|mainnet)/i;
const unscopedVerified = (t: string): string[] => sentences(t).filter((x) => VERIFIED_CLAIM.test(x) && !/\b(not|never|until|no|nothing|only|none|without|yet|unverified)\b/i.test(x)).map((x) => x.trim().slice(0, 200));

test('hedge (rung 3): no scanned source still says there is no spend tool, testnet only, or that mainnet is refused or not designed', () => {
  const hits: string[] = [];
  for (const src of SOURCES) for (const line of readable(src).split('\n')) for (const [what, re] of STALE) if (re.test(line)) hits.push(`${src.name}: ${what}: ${line.trim().slice(0, 160)}`);
  assert.deepEqual(hits, []);
});

test('hedge (rung 3): BSV-only banned phrases are absent from the panel, dialogs, agent text and docs', () => {
  const hits: string[] = [];
  for (const src of SOURCES) for (const line of readable(src).split('\n')) for (const [what, re] of BSV_BANNED) if (re.test(line)) hits.push(`${src.name}: ${what}: ${line.trim().slice(0, 160)}`);
  assert.deepEqual(hits, []);
});

test('hedge (rung 3): nothing says the spend tool was verified against a real wallet or with real funds until the owner\'s record is in the PC checks file', () => {
  if (realFundsRecorded()) return; // then the sentence must be dated and scoped by whoever records it; this test stops asserting absence
  const hits: string[] = [];
  for (const src of SOURCES) for (const x of unscopedVerified(readable(src))) hits.push(`${src.name}: ${x}`);
  assert.deepEqual(hits, []);
});

test('hedge (rung 3): BSV-MODE.md and SECURITY.md carry the statements whose absence would be the overclaim', () => {
  const mode = read('docs/BSV-MODE.md');
  const sec = read('SECURITY.md');
  const readme = read('README.md');
  for (const [name, text] of [['docs/BSV-MODE.md', mode], ['SECURITY.md', sec], ['README.md', readme]] as const) {
    assert.match(text, /mainnet[^.]{0,100}(?:\bOFF\b|\boff by default\b)/, `${name}: mainnet is built and OFF by default`);
    assert.match(text, /only (the )?(owner|you)[^.]{0,80}(turn|switch)/i, `${name}: only the owner turns mainnet on`);
    assert.match(text, /ordinary tools/i, `${name}: an agent's ordinary tools are outside the controls`);
  }
  for (const [name, text] of [['docs/BSV-MODE.md', mode], ['SECURITY.md', sec]] as const) {
    assert.match(text, /wallet'?s own prompt[^.]{0,80}last gate/i, `${name}: the wallet's own prompt is the last gate`);
    if (!realFundsRecorded()) assert.match(text, /not (been )?verified[^.]{0,80}(real wallet|real funds)/i, `${name}: not verified against a real wallet or with real funds`);
    assert.match(text, /fake wallets? only|fake loopback wallet|against fakes/i, `${name}: tested against fakes only`);
  }
  assert.match(mode, /never (been )?(pointed|talked)[^.]*real/i, 'never pointed at the real, funded wallet');
  assert.match(readme, /not been verified against a real wallet or with real funds/i, 'README: not verified');
  assert.match(mode, /wallet-brc100-1\.0\.0/, 'the real wallet facts box');
  assert.match(mode, /text\/html/, 'the content type fact');
  assert.match(mode, /no prompt/i, 'the four read-only methods showed no prompt');
});

test('hedge (rung 3): the checks catch what they exist for (and let the scoped wording through)', () => {
  for (const t of ['Legion has no spend tool in this version.', 'There is no spend tool yet.', 'Legion BSV mode is testnet only.', 'Legion refuses mainnet.', 'Mainnet is not designed.', 'The engine is connected to nothing.']) assert.ok(STALE.some(([, re]) => re.test(t)), t);
  for (const t of ['The spend tool is risk-free.', 'You cannot lose funds.', 'Safe on mainnet.', 'It is production-ready.', 'There is no way to overspend.']) assert.ok(BSV_BANNED.some(([, re]) => re.test(t)), t);
  for (const t of ['The spend tool was verified with real funds.', 'It has been tested against a real wallet.']) assert.equal(unscopedVerified(t).length, 1, t);
  for (const t of ['It has not been verified against a real wallet or with real funds.', 'Nothing is verified with a real wallet until the owner\'s checks are recorded.']) assert.equal(unscopedVerified(t).length, 0, t);
  for (const t of ['The spend tool was built and tested against fake wallets only.', "Mainnet is built and OFF by default.", "Legion's own code has one tool that asks a wallet to build and sign a payment."]) assert.ok(!STALE.some(([, re]) => re.test(t)) && !BSV_BANNED.some(([, re]) => re.test(t)), t);
});
