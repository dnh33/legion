import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_PRESETS } from '../src/core/providers/presets.js';
import { feedbackFor, providerReportUrl, REPORT_PROVIDER_LABELS } from '../ui/src/providers/feedback.js';
import { repoRoot } from './ps-helpers.js';

const FORM = join(repoRoot, '.github/ISSUE_TEMPLATE/provider_report.yml');

test('the report link opens the provider form and carries only the provider and the Legion version', () => {
  const u = new URL(providerReportUrl('ollama', '0.2.6')!);
  assert.equal(u.origin + u.pathname, 'https://github.com/dnh33/legion/issues/new');
  assert.equal(u.searchParams.get('template'), 'provider_report.yml');
  assert.equal(u.searchParams.get('provider'), 'Ollama');
  assert.equal(u.searchParams.get('version'), '0.2.6');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['provider', 'template', 'version']);
});

test('each new card has its own provider name in the link, and no other provider has a link', () => {
  for (const [id, label] of [['openai', 'OpenAI'], ['ollama', 'Ollama'], ['lmstudio', 'LM Studio'], ['vllm', 'vLLM']] as const) {
    assert.equal(new URL(providerReportUrl(id, '1')!).searchParams.get('provider'), label);
    assert.equal(feedbackFor(id, '1')?.label, 'New. Tell us how it works');
  }
  assert.equal(providerReportUrl('openrouter', '1'), undefined);
  assert.equal(providerReportUrl('mygateway', '1'), undefined);
  assert.equal(feedbackFor('mygateway', '1'), undefined);
});

test('the version is encoded, and an unknown version leaves the field out', () => {
  assert.equal(new URL(providerReportUrl('vllm', '0.2.6 beta&x=1#z')!).searchParams.get('version'), '0.2.6 beta&x=1#z');
  assert.equal(new URL(providerReportUrl('vllm', '0.2.6 beta&x=1#z')!).searchParams.get('x'), null);
  assert.equal(new URL(providerReportUrl('vllm', '')!).searchParams.has('version'), false);
  assert.equal(new URL(providerReportUrl('vllm', 'a'.repeat(500))!).searchParams.get('version')!.length, 40);
});

test('the link is an https GitHub address, so the app opens it through its checked external-link path', () => {
  for (const id of ['openai', 'ollama', 'lmstudio', 'vllm']) assert.match(providerReportUrl(id, '0.2.6')!, /^https:\/\/github\.com\/dnh33\/legion\/issues\/new\?/);
});

test('the issue form has the provider dropdown the link fills in, with exactly the names the link uses', () => {
  assert.ok(existsSync(FORM), 'the form exists');
  const t = readFileSync(FORM, 'utf8');
  assert.match(t, /^name: Provider report/m);
  assert.match(t, /- type: dropdown\n\s+id: provider\b/);
  assert.match(t, /- type: input\n\s+id: version\b/);
  for (const label of Object.values(REPORT_PROVIDER_LABELS)) assert.ok(t.includes(label), label);
  for (const word of ['OpenRouter', 'custom']) assert.match(t, new RegExp(word, 'i'));
  assert.doesNotMatch(t, /—|–/, 'no em dash');
  for (const need of ['plain answer', 'tool calls', 'approvals', 'long chats', 'cost']) assert.match(t, new RegExp(need, 'i'), need);
});

test('every preset the link names exists as a card', () => {
  const ids = new Set(PROVIDER_PRESETS.map((p) => p.id));
  for (const id of Object.keys(REPORT_PROVIDER_LABELS)) assert.ok(ids.has(id), id);
});
