import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, normalizeBsv, redactConfig } from '../src/shared/config.js';

function withHome<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'legion-bsvcfg-'));
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
