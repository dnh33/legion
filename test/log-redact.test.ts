/** The log redactor (plan-logging.md): general shapes from scrubSecrets, plus exact values, device codes and URL queries. */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { scrubSecrets } from '../src/core/comms/scrub.js';
import { clearRegisteredSecrets, redact, registerSecret, registerSecretBytes } from '../src/core/log/redact.js';

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const PAT = 'github' + '_pat_' + '11ABCDEFG0123456789abc' + '_' + 'x'.repeat(59);
const GHP = 'gh' + 'p_' + 'a'.repeat(36);

afterEach(() => clearRegisteredSecrets());

describe('scrub.ts: github_pat_', () => {
  it('masks a fine-grained personal access token for every caller', () => {
    const out = scrubSecrets(`token ${PAT} end`);
    assert.equal(out.includes('github' + '_pat_'), false);
    assert.match(out, /token \[redacted-token\] end/);
  });
  it('still masks the classic gh*_ shapes', () => {
    assert.equal(scrubSecrets(`x ${GHP} y`).includes(GHP), false);
  });
});

describe('log redactor: exact values', () => {
  const SECRET = 'admin-secret-' + 'Zq7'.repeat(8);
  it('masks a registered value as raw, base64, base64url, unpadded base64 and hex', () => {
    registerSecret(SECRET);
    const b = Buffer.from(SECRET, 'utf8');
    for (const form of [SECRET, b.toString('base64'), b.toString('base64url'), b.toString('base64').replace(/=+$/, ''), b.toString('hex')]) {
      const out = redact(`k=${form};`);
      assert.equal(out.includes(form), false, form);
      assert.match(out, /\[redacted-secret\]/);
    }
  });
  it('ignores values too short to be secrets, so ordinary words survive', () => {
    registerSecret('short');
    assert.equal(redact('a short line'), 'a short line');
  });
  it('an unregistered value is not touched (the list is the only source)', () => {
    assert.equal(redact(`k=${SECRET};`), `k=${SECRET};`);
  });
});

describe('log redactor: device flow codes', () => {
  it('masks the device code and the user code next to their labels', () => {
    const out = redact('device_code=3584d83530557fdd1f46af8289938c8ef79f9dc5 user_code: WDJB-MJHT');
    assert.equal(out.includes('3584d835'), false);
    assert.equal(out.includes('WDJB-MJHT'), false);
    assert.match(out, /device_code=\[redacted-code\] user_code: \[redacted-code\]/);
  });
  it('masks a JSON-shaped device response', () => {
    const out = redact('{"device_code":"abcdEFGH1234ijkl","user_code":"ABCD-1234"}');
    assert.equal(out.includes('abcdEFGH1234ijkl'), false);
    assert.equal(out.includes('ABCD-1234'), false);
  });
  it('leaves an unlabelled code-shaped word alone', () => {
    assert.equal(redact('build ABCD-1234 passed'), 'build ABCD-1234 passed');
  });
});

describe('log redactor: URL query strings', () => {
  it('a signed URL loses its signature (scrubSecrets masks the whole URL)', () => {
    const out = redact('fetched https://pipelines.example.net/logs/9/job.txt?sv=2024&se=2026&sig=QWERTY123 ok');
    assert.equal(out.includes('sig='), false);
    assert.equal(out.includes('QWERTY123'), false);
  });
  it('keeps scheme, host and path and drops any other query (X-Amz-Signature, plain parameters)', () => {
    const out = redact('got https://bucket.s3.example.com/a/b.zip?X-Amz-Credential=AK1&X-Amz-Signature=deadbeef99 and https://example.com/p?page=2');
    assert.equal(out.includes('deadbeef99'), false);
    assert.equal(out.includes('page=2'), false);
    assert.match(out, /https:\/\/bucket\.s3\.example\.com\/a\/b\.zip\?\[redacted-query\]/);
    assert.match(out, /https:\/\/example\.com\/p\?\[redacted-query\]/);
  });
  it('leaves a URL without a query as it is', () => {
    assert.equal(redact('see https://example.com/docs/page'), 'see https://example.com/docs/page');
  });
});

describe('scrub.ts: tokens glued to other characters', () => {
  it('masks a gh*_ token preceded by "_" or a letter, and one followed by "_suffix"', () => {
    for (const line of [`x_${GHP}`, `id=${GHP}_suffix`, `ab${'_'}${GHP}`]) {
      const out = scrubSecrets(line);
      assert.equal(out.includes('a'.repeat(36)), false, line);
    }
    assert.match(scrubSecrets(`id=${GHP}_suffix`), /\[redacted-token\]_suffix$/);
  });
  it('masks a github_pat_ token glued to a word', () => {
    assert.equal(scrubSecrets(`x_${PAT}`).includes('x'.repeat(59)), false);
  });
  it('does not mask a word that merely ends in gh (no false start inside a word)', () => {
    assert.equal(scrubSecrets('sleighp_' + 'b'.repeat(25)), 'sleighp_' + 'b'.repeat(25));
  });
});

describe('log redactor: binary secrets', () => {
  it('registerSecretBytes masks the base64, base64url and hex forms of raw key bytes', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));
    registerSecretBytes(key);
    for (const form of [key.toString('base64'), key.toString('base64').replace(/=+$/, ''), key.toString('base64url'), key.toString('hex'), key.toString('hex').toUpperCase()]) {
      assert.equal(redact(`KEY ${form}`).includes(form), false, form);
    }
  });
});

describe('log redactor: hostile input', () => {
  it('stays fast on a 200k line of chained schemes with no spaces', () => {
    for (const unit of ['http://', 'http://,', 'https://a,']) {
      const line = unit.repeat(Math.ceil(200_000 / unit.length));
      const t0 = performance.now();
      redact(line);
      const ms = performance.now() - t0;
      assert.ok(ms < 1500, `${unit}: ${ms.toFixed(0)} ms`);
    }
  });
});

describe('log redactor: general shapes come from scrubSecrets', () => {
  it('masks sk-, Bearer, a private-key block and a bare 64-hex value', () => {
    const line = 'sk' + '-' + 'q'.repeat(30) + ' Bearer ' + 'b'.repeat(29) + '1' + ' -----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIa\n-----END RSA ' + 'PRIVATE KEY----- ' + 'f'.repeat(64);
    const out = redact(line);
    assert.equal(out.includes('q'.repeat(30)), false);
    assert.equal(out.includes('b'.repeat(30)), false);
    assert.equal(out.includes('MIIa'), false);
    assert.equal(out.includes('f'.repeat(64)), false);
  });
});
