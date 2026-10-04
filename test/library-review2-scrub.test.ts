import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findForbiddenSecretInField, findForbiddenSecret } from '../src/core/comms/scrub.js';
import { Graph } from '../src/core/kg/graph.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';

// The reviewer's original phrase ('witch collapse practice feed shame open despair creek road again ice least') is not BIP-39:
// witch, collapse, shame and least are not on the official English list (67% hits). No wordlist detector can flag it and also
// let R2-S3's fruit and recovery-step lists (also 67% hits) through, so the probe uses the BIP-39 test vector below, all 12 on the list.
const P12 = 'army van defense carry jealous true garbage claim echo media make crunch';
const P12b = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const P24 = 'void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold';
const words = (p: string) => p.split(' ');

test('R2-S1 false negatives: layouts/labels an honest bot would plausibly write', () => {
  const cases: Record<string, string> = {
    'label: wallet phrase': `wallet phrase: ${P12}`,
    'label: restore phrase': `restore phrase: ${P12}`,
    'label: restore': `restore: ${P12}`,
    'label: recovery sentence': `recovery sentence: ${P12}`,
    'label: key words': `key words: ${P12b}`,
    'label: master key': `master key: ${P12}`,
    'label: SRP': `SRP: ${P12}`,
    'label: seed words in danish': `gendannelsesord: ${P12}`,
    'label: nogleord': `nøgleord: ${P12}`,
    'label: frase': `hemmelig frase: ${P12}`,
    'label: frø': `frø: ${P12}`,
    'no label, prose before and after': `Here is what the user pasted into the chat earlier, please keep it safe: ${P12}. Thanks for helping.`,
    'no label, 24 words inside sentence': `Note to self ${P24} end of note`,
    'bullet • separators': `seed: ${words(P12).join(' • ')}`,
    'middle dot separators': `seed: ${words(P12).join(' · ')}`,
    'arrow separators': `seed: ${words(P12).join(' -> ')}`,
    'plus separators': `seed: ${words(P12).join(' + ')}`,
    'braces': `seed: ${words(P12).map((w) => `{${w}}`).join(' ')}`,
    'hash numbering #1': `seed: ${words(P12).map((w, i) => `#${i + 1} ${w}`).join(' ')}`,
    'JSON w1..w12 keys': `seed: ${JSON.stringify(Object.fromEntries(words(P12).map((w, i) => [`w${i + 1}`, w])))}`,
    'JSON array': JSON.stringify({ seed: words(P12) }),
    'interleaved filler "the"': `seed: ${words(P12).map((w) => w + ' the').join(' ')}`,
    'uppercase': `SEED PHRASE: ${P12.toUpperCase()}`,
    'two-line split with label between': `seed: ${words(P12).slice(0, 6).join(' ')}\n(continued)\n${words(P12).slice(6).join(' ')}`,
    'word, newline, 5 blank lines between': `seed:\n${words(P12).join('\n\n\n\n\n')}`,
    'hex of phrase': `seed: ${Buffer.from(P12).toString('hex')}`,
    'base64 of phrase': `seed: ${Buffer.from(P12).toString('base64')}`,
    'rot13': `seed: ${P12.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97))}`,
    'spaced letters': `seed: ${P12.split('').join(' ')}`,
    'first 4 letters only': `seed: ${words(P12).map((w) => w.slice(0, 4)).join(' ')}`,
  };
  const leaked: string[] = [];
  for (const [k, v] of Object.entries(cases)) if (!findForbiddenSecretInField(v)) leaked.push(k);
  console.log('R2-S1 LEAKED:', JSON.stringify(leaked));
  assert.deepEqual(leaked, [], `stored (not refused): ${leaked.join(' | ')}`);
});

test('R2-S2 false negatives: where the phrase sits in the node (graph.upsertNode, as a clean bot)', () => {
  const g = new Graph({ dir: cleanupTemp('r2s-') });
  const a = agentActor('alpha', { taskId: 'T1' });
  const attempt = (name: string, input: Parameters<Graph['upsertNode']>[1]): string | undefined => {
    try { g.upsertNode(a, { scope: 'agent:alpha', ...input }); return name; } catch { return undefined; }
  };
  const stored = [
    attempt('12 words split over 12 tags', { title: 'k1', tags: words(P12) }),
    attempt('12 words split over 12 prop values', { title: 'k2', props: Object.fromEntries(words(P12).map((w, i) => [`p${i}`, w])) }),
    attempt('12 words as 12 prop KEYS', { title: 'k3', props: Object.fromEntries(words(P12).map((w) => [w, 1])) }),
    attempt('label in title, words in props values joined', { title: 'seed phrase', props: { a: words(P12).slice(0, 6).join(' '), b: words(P12).slice(6).join(' ') } }),
    attempt('label in body, two halves in body+tags', { title: 'k5', body: 'seed:', tags: [words(P12).slice(0, 6).join(' '), words(P12).slice(6).join(' ')] }),
    attempt('half in title half in body', { title: words(P12).slice(0, 6).join(' ') + ' (seed)', body: words(P12).slice(6).join(' ') }),
    attempt('sources ref', { title: 'k7', body: 'x', sources: [{ ref: `seed: ${P12}`, untrusted: true }] as never }),
  ].filter(Boolean) as string[];
  console.log('R2-S2 STORED:', JSON.stringify(stored));
  assert.deepEqual(stored, []);
});

test('R2-S3 false positives that REFUSE a whole legitimate write', () => {
  const fp: Record<string, string> = {
    'list of 12 JS frameworks as a body': 'react vue angular svelte solid preact alpine htmx astro remix next nuxt',
    'wordle answer list body': 'crane slate adieu audio stare roate raise arise alert later tales stone',
    'fruit list body': 'apple banana cherry grape lemon mango melon olive peach pear plum lime',
    'keywords label + 12 tech words': 'seed data tools: postgres redis kafka docker nginx linux grafana prometheus traefik vault consul nomad',
    'words: label in a glossary': 'words: serde tokio hyper axum tower tracing clap anyhow thiserror rayon crossbeam parking',
    'passphrase policy text': 'Passphrase options: correct horse battery staple correct horse battery staple correct horse battery staple',
    'backup list of folder names': 'backup: documents pictures videos music desktop downloads projects archive scripts configs secrets exports',
    'recovery runbook step list': 'recovery steps: stop start drain flush restore verify promote switch notify close audit report',
    'seed command (code)': 'npm run seed -- users orders products invoices payments refunds coupons carts reviews tags brands vendors',
    'BRC list': 'BRC list: brc-100 brc-103 brc-104 brc-105 brc-106 brc-107 brc-108 brc-109 brc-110 brc-111 brc-112 brc-113',
    'changelog line': 'Changelog seed words: added fixed removed changed deprecated security performance docs tests build chore style',
    'danish prose with label backup': 'backup: kører hver nat til den eksterne disk som står hos kunden',
    'danish ascii-only prose': 'backup: det hele bliver gemt hver nat paa serveren hos den store kunde som vil have det saadan',
    '12 team member first names': 'Team roster: alice bobby carol david emily frank grace henry irene james karen louis',
    'txid list (two 64-hex)': 'a'.repeat(64) + ' ' + 'b'.repeat(64),
    'BIP39 doc statement': 'BIP-39 turns 128 bits of entropy into 12 words from a 2048-word list; 24 words encode 256 bits plus checksum.',
  };
  const refused: string[] = [];
  for (const [k, v] of Object.entries(fp)) if (findForbiddenSecretInField(v)) refused.push(k);
  console.log('R2-S3 REFUSED (false positive):', JSON.stringify(refused));
  assert.deepEqual(refused, []);
});

test('R2-S4 interleaving 4 stopwords defeats the labelled check (prose heuristic is attacker-controlled)', () => {
  assert.ok(findForbiddenSecret(`seed: ${words(P12).map((w, i) => i % 3 === 0 ? w + ' the' : w).join(' ')}`));
});
