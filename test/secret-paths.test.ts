// test/secret-paths.test.ts: which paths count as secret files (yes-list, documented-shape exemptions, look-alikes)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretPath } from '../src/core/secret-paths.js';

test('isSecretPath: env files, keys, ssh and cloud credentials yes', () => {
  for (const p of ['C:/p/.env', '/p/.env.production', '/p/.env.local', 'C:/Users/a/.ssh/id_ed25519', '/h/.aws/credentials', '/p/.npmrc', '/p/server.pem', '/p/tls.key', '/p/id_rsa', '/p/id_rsa_old', 'C:\\p\\.env', 'C:\\Users\\a\\.SSH\\config', '/h/.gnupg/pubring.kbx']) assert.equal(isSecretPath(p), true, p);
});
test('isSecretPath: other credential stores yes, either slash, any case', () => {
  for (const p of ['/h/.netrc', '/h/.pgpass', '/h/.pypirc', '/h/.git-credentials', '/h/.docker/config.json', 'C:\\Users\\a\\.docker\\config.json', '/h/.kube/config', 'C:\\Users\\a\\.KUBE\\Config', '/h/.PGPASS']) assert.equal(isSecretPath(p), true, p);
});
test('isSecretPath: look-alikes and documented-shape files no', () => {
  for (const p of ['/p/environment.ts', '/p/src/env.ts', '/p/README.md', '/p/keyboard.ts', '/p/.env.example', '/p/.env.sample', '/p/.env.template', '/p/id_rsa.pub', '/p/docker/config.json', '/p/kube/config.ts', '/p/pgpass.md', '/p/.kube/config.ts', '/p/pypirc.txt']) assert.equal(isSecretPath(p), false, p);
});
