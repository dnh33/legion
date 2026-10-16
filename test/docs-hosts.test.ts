import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCS_HOSTS, loadDocsHosts } from '../src/shared/docs-hosts.js';

// Hosts that serve what any user uploads: a read there can carry anything, so none may be on the built-in list.
const USER_CONTENT = [/(^|\.)gist\.github\.com$/, /^raw\.githubusercontent\.com$/, /\.github\.io$/, /^github\.com$/, /pastebin|hastebin|paste\./, /^huggingface\.co$/, /\.vercel\.app$/, /\.pages\.dev$/, /\.netlify\.app$/, /notion\.site$/, /\.herokuapp\.com$/, /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|is\.gd|ow\.ly)$/, /^(www\.)?(dropbox|drive\.google|docs\.google)\.com$/, /^(www\.)?reddit\.com$/];

test('no user-content host is on the built-in docs list', () => {
  for (const h of DOCS_HOSTS) for (const re of USER_CONTENT) assert.equal(re.test(h), false, `${h} serves user uploads (${re})`);
});
test('the list is lower case, unique, has no scheme, path or trailing dot, and about 25 hosts', () => {
  for (const h of DOCS_HOSTS) assert.match(h, /^[a-z0-9.-]+\.[a-z]{2,}$/, h);
  assert.equal(new Set(DOCS_HOSTS).size, DOCS_HOSTS.length);
  assert.ok(DOCS_HOSTS.length >= 20 && DOCS_HOSTS.length <= 40, String(DOCS_HOSTS.length));
});
test('loadDocsHosts normalises a test list', () => { assert.deepEqual([...loadDocsHosts(['Docs.Example.com.'])], ['docs.example.com']); });
