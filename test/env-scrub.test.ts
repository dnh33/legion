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
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'STRIPE_SECRET', 'OPENAI_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY']) assert.equal(k in out, false, k);
  for (const k of ['PATH', 'HOME', 'NODE_ENV', 'TOKENIZERS_PARALLELISM', 'AWS_REGION']) assert.equal(out[k], base[k as keyof typeof base], k);
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
  for (const k of ['GITHUB_TOKEN_2', 'API_KEY_ID', 'MY_SECRET_VALUE', 'SOME_CREDENTIALS', 'X_APIKEY_Y', 'DB_PASSWD_OLD']) assert.equal(k in out, false, k);
  for (const k of ['KEYBOARD_LAYOUT', 'TOKENIZERS_PARALLELISM', 'MONKEY_COUNT', 'SECRETARY', 'PWD', 'my_tokens_a']) assert.equal(k in out, true, k);
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
test('buildChildEnv sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 when scrub is on in api-key mode, not when it is off', () => {
  const prev = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB; delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  try {
    const cfg = defaultConfig(); cfg.claude.auth = 'api-key'; cfg.claude.apiKey = 'sk-' + 'ant-config-key-0123456789';
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
test('Legion\'s own CLI settings that end in TOKENS survive the scrub', () => {
  const prev = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS; process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000';
  try { assert.equal(buildChildEnv(defaultConfig()).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000'); assert.equal(scrubSecretEnv({ OPENAI_MAX_TOKENS: '9' }).OPENAI_MAX_TOKENS, '9'); }
  finally { if (prev === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS; else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = prev; }
});
test('git\'s config-by-environment set stays whole', () => {
  const out = scrubSecretEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat', GIT_CONFIG_KEY_X: 'y' });
  assert.equal(out.GIT_CONFIG_COUNT, '1'); assert.equal(out.GIT_CONFIG_KEY_0, 'core.pager'); assert.equal(out.GIT_CONFIG_VALUE_0, 'cat'); assert.equal('GIT_CONFIG_KEY_X' in out, false);
});

test('the CLI scrub flag is set only in api-key and cloud mode; in Claude-login runs the keep list decides alone', () => {
  const names = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'NPM_TOKEN'];
  const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    for (const k of names) delete process.env[k];
    process.env.NPM_TOKEN = 'npm_owner';
    const plan = defaultConfig();
    assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in buildChildEnv(plan), false, 'plan only');
    assert.equal(buildChildEnv(plan, { scrub: { keep: ['NPM_TOKEN'] } }).NPM_TOKEN, 'npm_owner', 'kept in a plan-only run');
    const billing = defaultConfig(); billing.claude.allowApiBilling = true;
    assert.equal('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in buildChildEnv(billing), false, 'login with billing');
    assert.equal(buildChildEnv(billing, { scrub: { keep: ['NPM_TOKEN'] } }).NPM_TOKEN, 'npm_owner');
    const key = defaultConfig(); key.claude.auth = 'api-key'; key.claude.apiKey = 'sk-' + 'ant-config-key-0123456789';
    assert.equal(buildChildEnv(key).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1', 'api-key');
    for (const v of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      process.env[v] = '1';
      assert.equal(buildChildEnv(plan).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1', v);
      delete process.env[v];
    }
  } finally { for (const k of names) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});
test('api-key mode removes an inherited ANTHROPIC_AUTH_TOKEN, unless a cloud login is in use', () => {
  const names = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK'];
  const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer_owner'; delete process.env.CLAUDE_CODE_USE_BEDROCK;
    const key = defaultConfig(); key.claude.auth = 'api-key'; key.claude.apiKey = 'sk-' + 'ant-config-key-0123456789';
    assert.equal('ANTHROPIC_AUTH_TOKEN' in buildChildEnv(key), false);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in buildChildEnv(key, { scrub: false }), false, 'also with the scrub off');
    assert.equal(buildChildEnv(key, { scrub: { keep: ['ANTHROPIC_*'] } }).ANTHROPIC_AUTH_TOKEN, undefined, 'also when the keep list names it');
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    assert.equal(buildChildEnv(key).ANTHROPIC_AUTH_TOKEN, 'bearer_owner', 'cloud login keeps it');
  } finally { for (const k of names) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
});
test('more secret names go: PAT, PASS, PASSPHRASE, AUTH, JWT, COOKIE words and the AUTHTOKEN and _PWD endings', () => {
  const secret = ['GITHUB_PAT', 'GH_PAT', 'DB_PASS', 'MYSQL_PWD', 'GPG_PASSPHRASE', 'PASSPHRASE', 'npm_config__authToken', 'NPM_CONFIG__AUTH', 'DOCKER_AUTH_CONFIG', 'JWT', 'CI_JOB_JWT', 'COOKIE', 'AUTH_COOKIE', 'NPM_CONFIG_//registry.npmjs.org/:_authToken'];
  const env: Record<string, string> = { CONN: 'Server=h;User Id=u;Password=pw;', CONN2: 'host=h pwd=pw', URLQ: 'postgres://h/db?password=pw' };
  for (const k of secret) env[k] = 'v';
  const out = scrubSecretEnv(env);
  for (const k of [...secret, 'CONN', 'CONN2', 'URLQ']) assert.equal(k in out, false, k);
});
test('look-alikes stay: PATH, PATHEXT, COMPASS_HOME, AUTHOR_NAME, PASSENGER_COUNT, a value that only mentions a password', () => {
  const keep = { PATH: 'p', PATHEXT: '.EXE', COMPASS_HOME: '/c', AUTHOR_NAME: 'a', PASSENGER_COUNT: '2', GIT_AUTHOR_NAME: 'n', NOTE: 'the password is set elsewhere', SSH_AUTH_SOCK: '/s' };
  const out = scrubSecretEnv(keep);
  for (const k of Object.keys(keep)) assert.equal(k in out, true, k);
});
test('AWS_PROFILE and AWS_REGION stay, the AWS keys still go; ALL_PROXY stays in any case', () => {
  const out = scrubSecretEnv({ AWS_PROFILE: 'dev', AWS_REGION: 'eu', AWS_DEFAULT_REGION: 'eu', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_SESSION_TOKEN: 'c', ALL_PROXY: 'socks5://u:p@h:1', all_proxy: 'socks5://u:p@h:1' });
  for (const k of ['AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'ALL_PROXY', 'all_proxy']) assert.equal(k in out, true, k);
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) assert.equal(k in out, false, k);
});
test('more code-loading variables are dropped, and the keep list can bring one back', () => {
  const names = ['PROMPT_COMMAND', 'GIT_SSH_COMMAND', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'PERLLIB', 'PERL5LIB', 'RUBYLIB'];
  const env = Object.fromEntries(names.map((k) => [k, 'x']));
  const out = scrubSecretEnv(env);
  for (const k of names) assert.equal(k in out, false, k);
  assert.equal(scrubSecretEnv(env, { keep: ['GIT_SSH_COMMAND'] }).GIT_SSH_COMMAND, 'x');
});
