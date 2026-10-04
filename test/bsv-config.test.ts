import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, normalizeBsv, redactConfig } from '../src/shared/config.js';
import { createBsvState } from '../src/core/bsv/state.js';

function withHome<T>(fn: (dir: string) => T): T {
  const dir = cleanupTemp('legion-bsvcfg-');
  const prev = process.env.LEGION_HOME;
  process.env.LEGION_HOME = dir;
  try { return fn(dir); } finally { if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev; }
}

test('default config has bsv off on testnet', () => {
  assert.deepEqual(defaultConfig().bsv, { enabled: false, network: 'testnet' });
});

test('first run writes the bsv default to config.json', () => withHome((dir) => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.bsv, { enabled: false, network: 'testnet' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).bsv, { enabled: false, network: 'testnet' });
}));

test('a legacy config.json without "bsv" loads fine and keeps its own values', () => withHome((dir) => {
  const legacy = { port: 4999, authToken: 'tok', workspaceDir: '/w', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 7 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy));
  const cfg = loadConfig();
  assert.deepEqual(cfg.bsv, { enabled: false, network: 'testnet' });
  assert.equal(cfg.port, 4999);
  assert.equal(cfg.authToken, 'tok');
  assert.equal(cfg.claude.maxTurns, 7);
}));

test('enabled survives a reload; the network can only ever be testnet', () => withHome((dir) => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ bsv: { enabled: true, network: 'mainnet' } }));
  assert.deepEqual(loadConfig().bsv, { enabled: true, network: 'testnet' });
}));

test('garbage under "bsv" falls back to the safe default', () => {
  for (const junk of [true, 'yes', 7, null, [], { enabled: 'true' }, { enabled: 1 }]) {
    assert.deepEqual(normalizeBsv(junk), { enabled: false, network: 'testnet' }, JSON.stringify(junk));
  }
  withHome((dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ bsv: 'on' }));
    assert.deepEqual(loadConfig().bsv, { enabled: false, network: 'testnet' });
  });
});

test('redactConfig stays valid: secrets hidden, bsv passes through', () => {
  const cfg = defaultConfig();
  cfg.claude.apiKey = 'sk-secret';
  cfg.boat.apiKey = 'boat-secret';
  cfg.bsv.enabled = true;
  const r = redactConfig(cfg);
  assert.equal(r.authToken, '***');
  assert.equal(r.claude.apiKey, '***');
  assert.equal(r.boat.apiKey, '***');
  assert.deepEqual(r.bsv, { enabled: true, network: 'testnet' });
  assert.equal(JSON.stringify(r).includes('secret'), false);
});

test('a hand-edited bsv.walletUrl in config.json is ignored at load; Connect sets it in memory only and nothing writes it back', () => withHome((dir) => {
  const url = 'http://127.0.0.1:45009';
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 1, bsv: { enabled: true, network: 'testnet', walletUrl: url } }));
  const cfg = loadConfig();
  const state = createBsvState({ dataDir: dir, config: cfg });
  assert.equal(state.enabled, true, 'the enabled flag is still read');
  assert.equal(state.walletUrl, undefined, 'the address is not');
  state.setWalletUrl('http://127.0.0.1:45010');
  assert.equal(state.walletUrl, 'http://127.0.0.1:45010');
  assert.equal(createBsvState({ dataDir: dir, config: loadConfig() }).walletUrl, undefined, 'a restart forgets it: the owner types it again');
  state.set(false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).bsv, { enabled: false, network: 'testnet' }, 'toggling rewrites the bsv key without any address');
}));

test('the bsv.json fallback file cannot carry a wallet address either', () => withHome((dir) => {
  writeFileSync(join(dir, 'bsv.json'), JSON.stringify({ enabled: true, network: 'testnet', walletUrl: 'http://127.0.0.1:45011' }));
  const state = createBsvState({ dataDir: dir });
  assert.equal(state.enabled, true);
  assert.equal(state.walletUrl, undefined);
}));

test('config.json cannot carry the mainnet switch or a spend network: the bsv key keeps only enabled and the knowledge-mode network, whatever else is written there', () => withHome((dir) => {
  const sneaky = { enabled: true, network: 'mainnet', mainnetEnabled: true, mainnet: true, spendNetwork: 'main', spend: { mainnet: true }, nets: { main: { enabled: true } } };
  assert.deepEqual(normalizeBsv(sneaky), { enabled: true, network: 'testnet' });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ bsv: sneaky }));
  assert.deepEqual(loadConfig().bsv, { enabled: true, network: 'testnet' });
  const state = createBsvState({ dataDir: dir, config: loadConfig() });
  assert.equal(state.enabled, true);
  assert.equal(state.network, 'testnet');
  state.set(false); state.set(true);
  assert.deepEqual(loadConfig().bsv, { enabled: true, network: 'testnet' }, 'a toggle and a reload still read nothing else from that key (the switch lives only in the fingerprinted policy file)');
}));
