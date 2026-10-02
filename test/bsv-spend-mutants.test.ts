/**
 * Mutation per control (plan section 4 and 12.4). For each row: the compiled tree is copied, ONE literal edit is applied to a compiled file (the anchor must occur
 * exactly once, so a refactor that moves it fails this test instead of silently dropping the mutant), the copy is imported, and the named scenario from
 * test/bsv-spend-scenarios.ts must FAIL. The unmutated copy must pass every named scenario first. Production code carries no test hook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMods, SCENARIOS } from './bsv-spend-scenarios.js';

const DIST = fileURLToPath(new URL('../', import.meta.url));
const BSV = 'src/core/bsv/';
interface Mutant { id: string; control: string; scenario: string; edits: Array<{ file: string; from: string; to: string }> }
const E = (file: string, from: string, to: string) => ({ file: BSV + file, from, to });

const MUTANTS: Mutant[] = [
  { id: 'M01', control: 'C31 card -> approve: network compared at decide (both layers dropped)', scenario: 'flip-between-card-and-approve', edits: [E('spend.js', "if (fresh.network !== net)\n                return bail('wallet-network-changed');", ''), E('spend.js', 'walletNetwork: fresh.network });', 'walletNetwork: net });'), E('index.js', "policy.voidPending('the wallet reported a different network than before');", 'void 0;')] },
  { id: 'M02', control: 'C31 approve -> sign: fresh probe before signing', scenario: 'flip-between-approve-and-sign', edits: [E('spend.js', "if (fresh.network !== net) {\n            policy.mainnetOff('the wallet reported a different network right before signing');\n            return stop('wallet-network-changed');\n        }", '')] },
  { id: 'M03', control: 'C31 after the answer: probe after signing', scenario: 'flip-after-sign', edits: [E('spend.js', 'if (after.connected && after.network !== net) {', 'if (false) {')] },
  { id: 'M04', control: 'B3 canSign immediately before signing (Disable between approve and sign)', scenario: 'disable-between-approve-and-sign', edits: [E('spend.js', 'if (!policy.canSign(f.id)) {', 'if (false) {')] },
  { id: 'M05', control: 'C7 `executing` written before signing', scenario: 'audit-failure-before-and-after', edits: [E('spend.js', "audit.append({ agent: f.agentId, task: f.taskId, tool: SPEND_TOOL, decision: 'executing', fields: { requestId: f.id, net, totalSats: a.totalSats, sats: f.sats } });", 'void 0;')] },
  { id: 'M06', control: 'C7 `proposed` written before any wallet contact', scenario: 'audit-failure-before-and-after', edits: [E('spend.js', "decision: 'proposed', fields: { requestId: id, net: 'unknown', sats,", "decision: 'proposed-x', fields: { requestId: id, net: 'unknown', sats,")] },
  { id: 'M07', control: 'C8 a failed `executed` write freezes the chain', scenario: 'audit-failure-before-and-after', edits: [E('spend.js', "policy.freeze('the audit log could not record a finished spend');", 'void 0;')] },
  { id: 'M08', control: 'C10 taint read again at the decision', scenario: 'taint-is-read-again-at-decision', edits: [E('spend.js', "if ((f.job?.taint() ?? true) && !card.requiredConfirmations.includes('untrusted-content'))", 'if (false)')] },
  { id: 'M09', control: 'C11 a lost connection is `unknown`, never `failed`', scenario: 'sign-outcomes-unknown-block-everything', edits: [E('spend.js', "if (answer.kind === 'refused') {", 'if (true) {')] },
  { id: 'M10', control: 'C13 a late answer is evidence, never a state change', scenario: 'late-answer-is-evidence-only', edits: [E('spend.js', "if (engine !== 'approved') {", 'if (false) {')] },
  { id: 'M11', control: 'C14 the same key returns the stored state (no second build)', scenario: 'idempotent-key-and-key-reuse', edits: [E('spend.js', 'const seen = id ? flows.get(id) : undefined;', 'const seen = undefined;')] },
  { id: 'M12', control: 'C15 the signed outputs are compared with the card', scenario: 'signed-something-else-freezes', edits: [E('spend.js', 'const same = want === got && dec.feeSats === f.feeSats;', 'const same = true;')] },
  { id: 'M13', control: 'C2 only a run the owner started in the app', scenario: 'gates-refuse-before-any-wallet-contact', edits: [E('spend.js', 'if (!job || job.origin !== undefined)', 'if (!job)')] },
  { id: 'M14', control: 'C26 the network is never an input', scenario: 'gates-refuse-before-any-wallet-contact', edits: [E('spend.js', 'if (NOT_INPUTS.some((k) => args[k] !== undefined))', 'if (false)')] },
  { id: 'M15', control: 'C30 the recipient belongs to the pinned network before the wallet builds anything', scenario: 'policy-refusals-use-decoded-values', edits: [E('spend.js', "if (addressNet(f.recipient) !== net)\n            return deny(['address-network-mismatch']);", '')] },
  { id: 'M16', control: 'C4 the engine is handed the DECODED values', scenario: 'policy-refusals-use-decoded-values', edits: [E('spend.js', 'decoded: { inputSats: dec.inputSats, outputs, feeSats: dec.feeSats }', 'decoded: { inputSats: f.sats, outputs: [{ recipient: f.recipient, sats: f.sats }], feeSats: 0 }')] },
  { id: 'M17', control: 'C6 at most one extra output', scenario: 'output-check-extra-outputs', edits: [E('spend.js', 'rest.length > 1', 'false')] },
  { id: 'M18', control: 'C12 only a verified chain clears an unknown outcome', scenario: 'restart-keeps-unknown-until-verified-resolution', edits: [E('index.js', 'audit.verifiedEntries(', 'audit.entries(')] },
  { id: 'M19', control: 'C16 an unsigned transaction is aborted', scenario: 'deny-and-expiry-release-everything', edits: [E('spend.js', 'if (!f.reference || f.aborted)', 'if (true)')] },
  { id: 'M20', control: 'C23 the decision route needs the native secret', scenario: 'decision-rechecks-and-hash', edits: [E('index.js', "async ({ req, params, body }) => {\n                requireNative(req);\n                const r = await spend.decide(", "async ({ req, params, body }) => {\n                const r = await spend.decide(")] },
  { id: 'M21', control: 'C25 mainnet switch off: nothing is built', scenario: 'mainnet-end-to-end-with-restart', edits: [E('spend.js', "if (!policy.mainnetEnabled)\n                return deny(['mainnet-disabled']);", '')] },
  { id: 'M22', control: 'C28 not armed: nothing is built', scenario: 'mainnet-end-to-end-with-restart', edits: [E('spend.js', "if (!policy.isArmed())\n                return deny(['not-armed']);", '')] },
  { id: 'M23', control: 'C15 a signed mismatch freezes the chain', scenario: 'signed-something-else-freezes', edits: [E('spend.js', "policy.freeze('the wallet signed a transaction that is not the one on the card');", 'void 0;')] },
  { id: 'M24', control: 'A1 a wallet that answers with a txid (signed early) freezes the chain', scenario: 'wallet-signed-early-freezes', edits: [E('spend.js', 'if (j.txid !== undefined || j.sendWithResults !== undefined)', 'if (false)')] },
  { id: 'M25', control: 'C5 outputs above inputs', scenario: 'decoder-rejects-bad-values', edits: [E('spend.js', 'if (outSats > inputSats)\n            return null;', '')] },
  { id: 'M26', control: 'C5 a zero-sat output', scenario: 'decoder-rejects-bad-values', edits: [E('spend.js', 'if (sats < 1)', 'if (false)')] },
  { id: 'M27', control: 'C5 a repeated transaction', scenario: 'decoder-rejects-bad-values', edits: [E('spend.js', 'if (byId.has(t.txid))', 'if (false)')] },
  { id: 'M29', control: 'C13 a tick while the post-sign probe runs does not rewrite an executed spend', scenario: 'testnet-happy-path', edits: [E('spend.js', "f.phase = 'closing';", 'void 0;')] },
  { id: 'M28', control: 'C22 the 24 h window is rebuilt per network from the audit log', scenario: 'mainnet-end-to-end-with-restart', edits: [E('policy.js', 'const net = parseNet(e.fields.net);', "const net = 'test';")] },
];

const applyMutant = (m: Mutant): string => {
  const root = mkdtempSync(join(DIST, '.mut-'));
  cpSync(join(DIST, 'src'), join(root, 'src'), { recursive: true });
  for (const e of m.edits) {
    const p = join(root, e.file);
    const text = readFileSync(p, 'utf8');
    const n = text.split(e.from).length - 1;
    assert.equal(n, 1, `${m.id}: the anchor must occur exactly once in ${e.file} (found ${n}): ${JSON.stringify(e.from.slice(0, 80))}`);
    writeFileSync(p, text.replace(e.from, () => e.to));
  }
  return root;
};

test('mutants: the unmutated copy passes every scenario the mutants use (so a red mutant means the control, not the harness)', async () => {
  const root = mkdtempSync(join(DIST, '.mut-'));
  try {
    cpSync(join(DIST, 'src'), join(root, 'src'), { recursive: true });
    const M = await loadMods(root);
    for (const name of new Set(MUTANTS.map((m) => m.scenario))) await SCENARIOS[name]!(M);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const m of MUTANTS) {
  test(`mutant ${m.id}: ${m.control} -> scenario ${m.scenario} must FAIL`, async () => {
    const root = applyMutant(m);
    try {
      const M = await loadMods(root);
      await assert.rejects(() => SCENARIOS[m.scenario]!(M), () => true, `${m.id} survived: ${m.control}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
void mkdirSync;
