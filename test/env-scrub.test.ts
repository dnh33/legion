import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubSecretEnv } from '../src/core/env-scrub.js';
import { buildHostShellEnv, buildChildEnv } from '../src/core/engine.js';
import { defaultConfig } from '../src/shared/config.js';
import { classifySafe } from '../src/shared/consequence.js';
import { gateValue, PRESETS } from '../src/shared/gates-registry.js';

const base = { PATH: 'p', HOME: 'h', NODE_ENV: 'test', TOKENIZERS_PARALLELISM: 'false', GITHUB_TOKEN: 'a', GH_TOKEN: 'b', NPM_TOKEN: 'c', STRIPE_SECRET: 'd', OPENAI_API_KEY: 'e', DB_PASSWORD: 'f', AWS_REGION: 'g', AWS_SECRET_ACCESS_KEY: 'h2' };
test('secret-looking names go, ordinary ones (also TOKENIZERS_PARALLELISM) stay', () => {
  const out = scrubSecretEnv(base);
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'STRIPE_SECRET', 'OPENAI_API_KEY', 'DB_PASSWORD', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY']) assert.equal(k in out, false, k);
  for (const k of ['PATH', 'HOME', 'NODE_ENV', 'TOKENIZERS_PARALLELISM']) assert.equal(out[k], base[k as keyof typeof base], k);
});
test('keep list: exact name in any case, and a trailing star for a prefix', () => {
  const out = scrubSecretEnv(base, { keep: ['github_token', 'AWS_*'] });
  assert.equal(out.GITHUB_TOKEN, 'a'); assert.equal(out.AWS_REGION, 'g'); assert.equal(out.AWS_SECRET_ACCESS_KEY, 'h2'); assert.equal('NPM_TOKEN' in out, false);
});
test('providerAuth leaves the cloud login variables alone', () => {
  const out = scrubSecretEnv({ ...base, ANTHROPIC_AUTH_TOKEN: 'x' }, { providerAuth: true });
  assert.equal(out.AWS_SECRET_ACCESS_KEY, 'h2'); assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'x'); assert.equal('GITHUB_TOKEN' in out, false);
});
test('a secret word as its own segment goes (GITHUB_TOKEN_2, API_KEY_ID, MY_SECRET_VALUE); look-alikes stay', () => {
  const env = { GITHUB_TOKEN_2: '1', API_KEY_ID: '2', MY_SECRET_VALUE: '3', SOME_CREDENTIALS: '4', X_APIKEY_Y: '5', DB_PASSWD_OLD: '6', my_tokens_a: '7', KEYBOARD_LAYOUT: 'us', TOKENIZERS_PARALLELISM: 'false', MONKEY_COUNT: '3', SECRETARY: 'x', PWD: '/w' };
  const out = scrubSecretEnv(env);
  for (const k of ['GITHUB_TOKEN_2', 'API_KEY_ID', 'MY_SECRET_VALUE', 'SOME_CREDENTIALS', 'X_APIKEY_Y', 'DB_PASSWD_OLD', 'my_tokens_a']) assert.equal(k in out, false, k);
  for (const k of ['KEYBOARD_LAYOUT', 'TOKENIZERS_PARALLELISM', 'MONKEY_COUNT', 'SECRETARY', 'PWD']) assert.equal(k in out, true, k);
});
test('a value that is a URL with a password goes; a URL without one stays', () => {
  const out = scrubSecretEnv({ DATABASE_URL: 'postgres://u:p@h/db', REDIS: 'redis://:pw@h:6379', PLAIN_URL: 'https://example.com/a', USER_AT: 'https://user@example.com/x', NOTE: 'a://b:c d@e' });
  assert.equal('DATABASE_URL' in out, false); assert.equal('REDIS' in out, false);
  assert.equal(out.PLAIN_URL, 'https://example.com/a'); assert.equal(out.USER_AT, 'https://user@example.com/x');
});
test('the never-strip names stay even when a rule matches (any case)', () => {
  const names = ['PATH', 'PATHEXT', 'PWD', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
  const env: Record<string, string> = {};
  // a proxy value with a password would match the URL rule; PWD is not a secret word but is listed
  for (const n of names) env[n] = n.endsWith('PROXY') ? 'http://u:p@proxy:8080' : 'v';
  for (const n of ['path', 'http_proxy', 'https_proxy', 'no_proxy', 'Temp']) env[n] = n.endsWith('proxy') ? 'http://u:p@proxy:8080' : 'v';
  const out = scrubSecretEnv(env);
  for (const k of Object.keys(env)) assert.equal(k in out, true, k);
});
test('injection-class variables go by default; the keep list overrides; providerAuth does not', () => {
  const env = { LD_PRELOAD: 'a', LD_AUDIT: 'b', LD_LIBRARY_PATH: 'c', DYLD_INSERT_LIBRARIES: 'd', DYLD_LIBRARY_PATH: 'e', NODE_OPTIONS: 'f', PYTHONSTARTUP: 'g', PYTHONPATH: 'h', BASH_ENV: 'i', ENV: 'j', PERL5OPT: 'k', RUBYOPT: 'l', node_options: 'm', PYTHONHOME: 'ok', ENVIRONMENT: 'ok', LD_DEBUG: 'ok' };
  const gone = ['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'PYTHONPATH', 'BASH_ENV', 'ENV', 'PERL5OPT', 'RUBYOPT', 'node_options'];
  const out = scrubSecretEnv(env);
  for (const k of gone) assert.equal(k in out, false, k);
  for (const k of ['PYTHONHOME', 'ENVIRONMENT', 'LD_DEBUG']) assert.equal(k in out, true, k);
  const kept = scrubSecretEnv(env, { keep: ['PYTHONPATH', 'DYLD_*'] });
  assert.equal(kept.PYTHONPATH, 'h'); assert.equal(kept.DYLD_LIBRARY_PATH, 'e'); assert.equal('NODE_OPTIONS' in kept, false);
  assert.equal('LD_PRELOAD' in scrubSecretEnv(env, { providerAuth: true }), false);
});
test('an inline NODE_OPTIONS= or LD_PRELOAD= prefix on a command is level 3 (pinned)', () => {
  for (const command of ['NODE_OPTIONS=--require=./x npm test', 'LD_PRELOAD=./x.so npm test']) assert.equal(classifySafe({ kind: 'approval', toolName: 'Bash', input: { command } }).level, 3, command);
});
test('the env-scrub gate is on in every preset, Bypass included', () => {
  for (const p of PRESETS) assert.equal(gateValue('env-scrub', { app: { version: 1, preset: p } }), true, p);
});
test('buildHostShellEnv drops the owner\'s GITHUB_TOKEN by default, keeps it with a keep entry, and everything with scrub false', () => {
  const prev = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'ghp_owner';
  try {
    assert.equal('GITHUB_TOKEN' in buildHostShellEnv(defaultConfig()), false);
    assert.equal(buildHostShellEnv(defaultConfig(), { keep: ['GITHUB_TOKEN'] }).GITHUB_TOKEN, 'ghp_owner');
    assert.equal(buildHostShellEnv(defaultConfig(), { scrub: false }).GITHUB_TOKEN, 'ghp_owner');
  } finally { if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev; }
});
test('buildChildEnv scrubs too, and api-key mode still gets its own key', () => {
  const prev = process.env.NPM_TOKEN; process.env.NPM_TOKEN = 'npm_owner';
  try {
    const cfg = defaultConfig(); cfg.claude.auth = 'api-key'; cfg.claude.apiKey = 'sk-' + 'ant-config-key-0123456789';
    const env = buildChildEnv(cfg);
    assert.equal('NPM_TOKEN' in env, false); assert.equal(env.ANTHROPIC_API_KEY, cfg.claude.apiKey);
    assert.equal(buildChildEnv(cfg, { scrub: false }).NPM_TOKEN, 'npm_owner');
  } finally { if (prev === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = prev; }
});
test('buildChildEnv sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 when scrub is on, not when it is off', () => {
  const prev = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  try {
    const cfg = defaultConfig();
    assert.equal(buildChildEnv(cfg).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal(buildChildEnv(cfg, { probe: true }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal(buildChildEnv(cfg, { scrub: { keep: ['X'] } }).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
    assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in buildChildEnv(cfg, { scrub: false }), false);
  } finally { if (prev === undefined) delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; else process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = prev; }
});
test('buildChildEnv with Bedrock on keeps the cloud login variables', () => {
  const names = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN'];
  const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'; process.env.AWS_SECRET_ACCESS_KEY = 'aws_owner'; process.env.NPM_TOKEN = 'npm_owner';
    const env = buildChildEnv(defaultConfig());
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'aws_owner'); assert.equal('NPM_TOKEN' in env, false);
  } finally { for (const k of names) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});
