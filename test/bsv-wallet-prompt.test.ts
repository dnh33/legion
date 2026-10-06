/**
 * Whether a wallet shows its own prompt for `signAction` depends on the wallet: BRC-100 does not define how a wallet identifies a local
 * app outside a browser (the originator `legion.local` is self-declared), so a wallet may prompt every time, once, or never (assumption
 * A6/U13, checks V5, V6, R6, W1..). The text a person reads in the app must not state the wallet's prompt as a fact, must say it depends
 * on the wallet, and must say what to do when none appears. The BSV docs may name it only next to a condition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from './bsv-scan.js';
import { MAINNET_WARNING } from '../src/core/bsv/wallet-probe.js';
import { MAINNET_ON_SENTENCE } from '../src/shared/bsv-view.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const dirFiles = (rel: string, re: RegExp) => readdirSync(join(REPO, rel)).filter((n) => re.test(n)).map((n) => `${rel}/${n}`);

/** Person-readable app text (strings and JSX text; comments are maintainer notes). spend.ts is pinned and has no such sentence. */
const SOURCES = [
  ...dirFiles('ui/src/bsv', /\.tsx?$/),
  ...dirFiles('src/shared', /^bsv-.*\.ts$/),
  ...dirFiles('src/core/bsv', /\.ts$/).filter((f) => !f.endsWith('/spend.ts')),
  'src/electron/admin-logic.ts',
].map((f) => ({ name: f, text: lex(read(f)).kept }));

/** A certainty about the wallet's prompt: "the wallet then shows its own prompt", "will show", "follows every time", "needs ... the wallet's own prompt", "... is the last gate". */
const CERTAIN = /wallet (?:will show|then shows|shows) its own prompt|own prompts? follows?|needs[^.]{0,80}(?:the|your) wallet'?s own prompt|then (?:the|your) wallet'?s own prompt|own prompts?[^.]{0,40}\b(?:is|are|remains?) the (?:real )?last gate|which is the last gate/i;
export const DEPENDS = /whether (?:your|the) wallet asks too depends on the wallet/;

test('wallet prompt: the check catches the old certainties', () => {
  for (const t of ['the wallet then shows its own prompt, which is the last gate.', 'Your wallet will show its own prompt next.', "The wallet's own prompt follows every time.", "Each spend still needs Arm, your confirmations and the wallet's own prompt."]) assert.match(t, CERTAIN, t);
  for (const t of ["a payment needs your confirmation in native dialogs and then your wallet's own prompt.", "the wallet's own prompts remain the real last gate for any spend"]) assert.match(t, CERTAIN, t);
  assert.doesNotMatch("Whether your wallet asks too depends on the wallet, and Legion's own code cannot see it.", CERTAIN);
  assert.doesNotMatch("The wallet's own prompt is not always the last gate.", CERTAIN);
});

test('wallet prompt: no app text states the wallet\'s own prompt as a certainty', () => {
  const hits: string[] = [];
  for (const s of SOURCES) for (const sent of s.text.split(/(?<=[.!?])\s+|\n/)) if (CERTAIN.test(sent)) hits.push(`${s.name}: ${sent.trim().slice(0, 200)}`);
  assert.deepEqual(hits, []);
});

test('wallet prompt: the sentences that name it say it depends on the wallet', () => {
  for (const [name, text] of [['MAINNET_WARNING', MAINNET_WARNING], ['MAINNET_ON_SENTENCE', MAINNET_ON_SENTENCE]] as const) {
    assert.match(text, DEPENDS, `${name}: says it depends on the wallet`);
  }
});

/** The docs may name the wallet's prompt, a last gate or a monthly limit only next to a condition (it depends on the wallet, an assumption, a check). */
const DOCS = ['docs/BSV-MODE.md', 'docs/BSV-WALLET-DESIGN.md', 'docs/TESTING-BSV.md', 'SECURITY.md', 'README.md']; // CHANGELOG.md: past releases are history, not rewritten
const NAMES = /own prompts?\b|last gate|monthly limit|two-stage/i;
/** A certainty fails even next to a condition word ("... is the last gate, even if you use mainnet"). */
const DOC_CERTAIN = new RegExp(`${CERTAIN.source}|approves there`, 'i');
const CONDITION = /depends on the wallet|\bwhether\b|\bif\b|\bmay\b|not always|not verified|unverified|assum|\brevised\b|\bU13\b|\bU4\b|\bA6\b|one-time|second check|no prompt|not observed|does not ask|stop condition/i;
/** Whole BSV docs; in the general docs only the lines that name BSV or a wallet. */
const bsvText = (f: string): string => (/BSV/.test(f) ? read(f) : read(f).split('\n').filter((l) => /BSV|wallet/i.test(l)).join('\n'));

test('wallet prompt: the BSV docs name the wallet prompt, a last gate or a monthly limit only with a condition', () => {
  const hits: string[] = [];
  for (const f of DOCS) for (const sent of bsvText(f).split(/(?<=[.!?;])\s+|\n/)) if (DOC_CERTAIN.test(sent) || (NAMES.test(sent) && !CONDITION.test(sent))) hits.push(`${f}: ${sent.trim().slice(0, 160)}`);
  assert.deepEqual(hits, []);
});

test('wallet prompt: the grant advice is shown before the build step too (the panel), not only in the dialogs after it', () => {
  assert.match(read('ui/src/bsv/BsvPanel.tsx'), /If it asks for a spending grant, choose one-time if it offers that, or a limit no higher than Legion\\'s caps\./);
});
