/**
 * BSV v1 review fixes, part 3: the pack tells the truth where a reader actually meets it (F5 titles, F10 present-tense claims, F12
 * behaviour not wording), comms refuses seed phrases (F8), and the pack's claims match what the code has (F12).
 * Local only: no model, no wallet, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBriefing } from '../src/core/kg/briefing.js';
import { applySeedPack, BSV_SEED_PATH, loadBsvSeed } from '../src/core/kg/seed.js';
import { agentActor } from '../src/core/kg/types.js';
import { CommsError } from '../src/core/comms/hub.js';
import { HUMAN, mkGraph } from './kg-helpers.js';
import { makeHarness } from './comms-fakes.test.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const pack = loadBsvSeed(BSV_SEED_PATH);
const design = pack.nodes.filter((n) => n.props?.built === false);
const asNode = (n: (typeof pack.nodes)[number]) => n as unknown as { id: string; title: string; body: string; tags: string[]; confidence: number; props?: Record<string, unknown> };

function loaded() {
  const m = mkGraph(); m.bsv.on = true;
  applySeedPack(m.g, pack);
  return m.g;
}

// ------------------------------------------------------------------ F5: the marker is where readers look

test('F5: every built:false node says so in its TITLE, its first line, a design tag and a low confidence (so titles in related lines and briefings cannot read as fact)', () => {
  assert.ok(design.length >= 6, `the pack has ${design.length} design nodes`);
  for (const raw of design) {
    const n = asNode(raw);
    assert.match(n.title, /^\[Design\] \S/, `${n.id}: title ${n.title}`);
    assert.ok(n.tags.includes('design'), `${n.id}: design tag`);
    assert.match(n.body, /^Design, not built in v0\.\n/, `${n.id}: first line`);
    assert.ok(n.confidence <= 0.6, `${n.id}: confidence ${n.confidence}`);
  }
  // and nothing unmarked carries the design title or tag
  for (const raw of pack.nodes.filter((n) => n.props?.built !== false)) {
    const n = asNode(raw);
    assert.doesNotMatch(n.title, /^\[Design\]/, n.id);
    if (n.props?.built === 'partly') assert.match(n.title, /^\[Partly built\] \S/, n.id);
    assert.ok(!n.tags.includes('design'), `${n.id} has the design tag but is not marked built:false`);
  }
});

test('F5: recall (hits AND "related" lines) and the Library briefing show a design node only with its [Design] title', () => {
  const g = loaded();
  const ASSAYER = agentActor('assayer');
  let checked = 0;
  for (const raw of design) {
    const n = asNode(raw);
    const bare = n.title.replace(/^\[Design\] /, '');
    for (const q of [bare, `${bare} approval broker tool handler`, n.id.replace(/^bsv-/, '').replace(/-/g, ' ')]) {
      const r = g.recall(ASSAYER, q, { scope: 'bsv' });
      const text = r.outline.split('\n').slice(1).join('\n'); // the first line echoes the query
      for (const m of text.matchAll(new RegExp(`(.{0,12})${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))) {
        assert.ok(/\[Design\] $/.test(m[1]!), `${n.id}: "${bare}" appears without its [Design] marker in recall for "${q}": …${m[0]}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 10, `only ${checked} design titles were seen in recall output; the check is not exercising anything`);
  // the briefing every bot gets while BSV is on
  const brief = renderBriefing(g.briefingParts('assayer', { prompt: 'audit log freeze button spend caps approval broker mainnet armed' }));
  for (const raw of design) {
    const bare = asNode(raw).title.replace(/^\[Design\] /, '');
    for (const m of brief.matchAll(new RegExp(`(.{0,12})${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))) assert.ok(/\[Design\] $/.test(m[1]!), `briefing shows "${bare}" without its marker: …${m[0]}`);
  }
});

// ------------------------------------------------------------------ F10 + F12: what the unmarked nodes may say

/** Words that name a control Legion does not have. In an unmarked node a sentence about one must be hedged (no / not / design / would / later ...). */
const CONTROL = /\bspend(ing)?[ -](limits?|polic(y|ies)|caps?)\b|\bfee ceiling\b|\baudit log\b|\bfreeze button\b|\bapproval (broker|card|gate)\b|\btool handler\b|\bmainnet[ -]arm|\barmed (mainnet|until)\b/i;
const HEDGE = /\b(no|not|never|nothing|without|design|designing|later|would|planned|yet|lesson|lessons|borrow|standing|monthly|if|when|should|must not|do not|does not|has no|have no)\b/i;
/** Present-tense claims about Legion behaviour that no code backs. Each came from a real review finding. */
const FALSE_CLAIMS: Array<[string, RegExp]> = [
  ['"Legion rule:" as if enforced', /\bLegion rule:/],
  ['links to a skill pack at install time', /links to it only at install time/i],
  ['"actions go only through" as a Legion fact', /\bLegion never generates, stores or loads keys; actions go only/i],
  ['spend limits as a thing Legion routes to', /route to an external BRC-100 wallet with spend limits/i],
  ['answer-only Assayer', /answer-only/i],
  ['nothing here can sign as a control', /nothing here can sign/i],
  ['a spend policy that exists', /ceiling in the spend policy/i],
  ['the comms hub scrubs seed phrases without saying it refuses them', /comms hub scrubs messages\b/i],
];

/** Sentences that name a control without claiming Legion has it, so they are not hedged (the reason is the point of the list). */
const NOT_A_CLAIM = new Set([
  'bsv-production-lessons', // generic advice to the reader ("keep an audit log"), not a Legion feature
  'bsv-brc-cheatsheet', // lists BRC-181 "agent spend policy": the name of an external standard
]);

test('F10/F12: no unmarked node states a control Legion does not have as a present-tense fact (every sentence about one is hedged), and the reviewed false phrases are gone', () => {
  const offenders: string[] = [];
  for (const raw of pack.nodes.filter((n) => n.props?.built !== false && n.props?.built !== 'partly')) {
    const n = asNode(raw);
    for (const s of n.body.split(/(?<=[.!?])\s+/)) if (!NOT_A_CLAIM.has(n.id) && CONTROL.test(s) && !HEDGE.test(s)) offenders.push(`${n.id}: ${s.slice(0, 160)}`);
    for (const [label, re] of FALSE_CLAIMS) if (re.test(n.body)) offenders.push(`${n.id}: ${label}`);
  }
  assert.deepEqual(offenders, []);
  // the specific nodes the reviewer named now say what is true
  const body = (id: string) => asNode(pack.nodes.find((x) => x.id === id)!).body;
  assert.match(body('bsv-tx-fees'), /no tool uses it yet because Legion has no spend tool/);
  assert.match(body('bsv-safety-ts-stack-server-keys'), /Legion has no wallet in this version/);
  assert.match(body('bsv-safety-copy-no-key-samples'), /Legion has no wallet in this version/);
  assert.match(body('bsv-src-bsv-skills'), /no installer/);
  assert.match(body('bsv-wallet-results-delayed-broadcast'), /none exists today/);
});

test('F9/F12: the status node says the Assayer is an ordinary agent with normal tools behind approval, and the preamble no longer says nothing can sign', async () => {
  const status = asNode(pack.nodes.find((n) => n.id === 'bsv-status-today')!).body;
  assert.match(status, /advisory bot whose only BSV tool is that read-only status check/);
  // G2: the truth from src/core/approvals.ts: in ask mode shell and file edits wait for approval, web fetch/search and read-only tools do not
  assert.match(status, /shell commands and file edits wait for your approval/);
  assert.match(status, /web fetch, web search and read-only tools run without a prompt/);
  assert.match(status, /switch its approval to full/);
  assert.doesNotMatch(status, /web fetch\) behind your approval/);
  assert.match(status, /Legion's own code has no tool that signs or sends BSV/);
  assert.doesNotMatch(status, /answer-only/);
  assert.doesNotMatch(status, /no wallet, no key handling/, 'there is now a status probe: the node must not say there is no wallet contact');
  const { BSV_PREAMBLE } = await import('../src/core/bsv/index.js');
  assert.doesNotMatch(BSV_PREAMBLE, /nothing here can sign/i);
  assert.match(BSV_PREAMBLE, /\[Design\]/, 'the preamble points at the marker readers will actually see');
  assert.match(BSV_PREAMBLE, /mcp__legion_bsv__bsv_status/, 'the preamble names the one wallet tool');
  assert.match(BSV_PREAMBLE, /Legion has no tool that signs, sends, reads balances or holds funds/);
  assert.equal(BSV_PREAMBLE.split('\n').length, 4);
});

// ------------------------------------------------------------------ F12: the pack's claims against the code

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p.replace(/\\/g, '/')); // forward slashes so endsWith/includes checks hold on Windows
  }
  return out;
}

test('F12: the BSV code still has none of the controls the design nodes describe, and the controls that landed are the ones the pack calls partly built (if another lands, the pack must be revisited: this test says so)', () => {
  const files = [...sourceFiles(join(REPO, 'src/core/bsv')), ...sourceFiles(join(REPO, 'ui/src/bsv'))];
  assert.ok(files.length >= 4);
  // Still absent: a spend approval card, any wallet call that creates, signs or reads outputs. (The audit log, Freeze, arming and the policy engine now exist, and the pack says "partly built".)
  const claims: Array<[string, RegExp, string?]> = [
    ['an approval card for spends in the interface', /spend[-_ ]?approval|approvalCard/i, 'ui/src/bsv'],
    ['a wallet connection beyond status', /walletclient|createaction|signaction|listoutputs|getpublickey|internalizeaction|createsignature/i],
  ];
  const found: string[] = [];
  for (const f of files) {
    // comments and string literals may NAME a control (the docs of what is absent); code identifiers may not
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    for (const [label, re, only] of claims) if ((!only || f.includes(only)) && re.test(code)) found.push(`${f.replace(REPO.replace(/\\/g, '/'), '')}: ${label}`);
  }
  assert.deepEqual(found, [], 'the code now has a control the pack calls design: update the pack and bsv-status-today first');
  // The ones that exist: files are there, and the pack says so with the partly-built marker
  for (const f of ['src/core/bsv/policy.ts', 'src/core/bsv/audit.ts', 'src/core/bsv/wallet-probe.ts']) assert.ok(files.some((x) => x.endsWith(f)), `${f} exists`);
  const partly = new Set(pack.nodes.filter((n) => n.props?.built === 'partly').map((n) => n.id));
  for (const id of ['bsv-safety-audit-freeze', 'bsv-safety-mainnet-armed-native', 'bsv-safety-spend-caps-approval', 'bsv-safety-external-wallet']) assert.ok(partly.has(id), `${id} must be partly built`);
});

// ------------------------------------------------------------------ F8: comms and seed phrases

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
// Published test vectors, not wallet material. Split so that no secret scanner matches the literal.
const WIF = '5Hue' + 'CGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';

test('F8: bot_send, room posts and human posts refuse a seed phrase: nothing is stored, no room is created, nobody is woken', () => {
  const h = makeHarness();
  const room = h.room(['zealot', 'scout']);
  const before = h.messages(room.id).length;
  const refused = (fn: () => unknown, label: string) => assert.throws(fn, (e: unknown) => e instanceof CommsError && e.status === 400 && /seed phrase/i.test(e.message), label);
  refused(() => h.hub.botSend('zealot', 'ranger', `restore with ${PHRASE}`), 'bot_send to a new peer');
  assert.equal(h.hub.listRooms().filter((r) => r.kind === 'dm').length, 0, 'no DM room was created by the refused message');
  refused(() => h.hub.botSend('zealot', 'scout', `here: ${PHRASE}`), 'bot_send to a peer in a room');
  refused(() => h.hub.roomPost('zealot', room.id, `@scout ${PHRASE}`), 'room_post');
  refused(() => h.hub.postHuman(room.id, `my phrase is ${PHRASE}`), 'human post');
  refused(() => h.hub.botSend('zealot', 'ranger', PHRASE.split(' ').join('\n')), 'one word per line');
  refused(() => h.hub.botSend('zealot', 'ranger', PHRASE.split(' ').map((w, i) => `${i + 1}. ${w}`).join(' ')), 'numbered list');
  assert.equal(h.messages(room.id).length, before, 'nothing was posted');
  assert.equal(h.engine.starts.length, 0, 'nobody was woken');
  assert.doesNotMatch(JSON.stringify(h.hub.search('abandon')), /abandon/);
});

test('F8: ordinary messages, and a private key (which is redacted, as before), still go through', () => {
  const h = makeHarness();
  const m = h.hub.botSend('zealot', 'scout', `the key ${WIF} must never be shared; also the word abandon is fine alone`);
  assert.doesNotMatch(m.text, new RegExp(WIF), 'the WIF was redacted');
  assert.match(m.text, /abandon is fine alone/);
  assert.ok(h.hub.botSend('zealot', 'scout', 'a normal message about txids 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08').id);
});

void HUMAN;
