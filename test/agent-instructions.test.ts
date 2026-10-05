/**
 * Agent-facing instructions must stay aligned with the tools that actually exist — without growing every release.
 *
 * ## The problem this prevents
 *
 * `renderCapabilities` builds "What you can do right now" from the servers a run really has, so a tool NAME can never
 * go stale: it is read from the live registration. What can go stale is everything around the names — the policy that
 * tells an agent when to reach for a tool, and the rules that tell it what a result means. Two examples that were
 * missing while the tool existed and worked:
 *
 *   - nothing told an agent that an outdated note is retired with `kg_supersede` rather than duplicated by a fresh
 *     capture, so a Library drifts toward several near-identical notes instead of one true one
 *   - nothing told an agent what to DO when `house_read` returns a file marked as not the app's own words, which is
 *     the exact case the trust wrapper exists for
 *
 * ## The bloat rule
 *
 * Every line here earns its place or it is a defect. A system prompt is paid for on every run, in every session, by
 * every agent — the most expensive real estate in the product. So:
 *
 *   - a line must state a DECISION the agent could not otherwise infer from the tool name
 *   - a line that restates a tool description belongs in the tool description
 *   - a line must be conditional on the capability being present, never unconditional
 *
 * The tests below are deliberately about shape, not exact wording: they would still pass after a rewrite, and fail
 * if a line is dropped, duplicated into the preamble, or made unconditional.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { renderCapabilities, FACTS_HEADER } from '../src/core/agent-facts.js';
import { HOUSE_PREAMBLE } from '../src/core/house/tools.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (p: string): string => readFileSync(join(REPO, p), 'utf8');

describe('agent instructions: aligned, and not bloated', () => {
  it('the capabilities block names the tools a run really has, so a name cannot go stale', () => {
    const facts = renderCapabilities(
      { id: 'zealot', name: 'Zealot', approval: 'ask' } as never,
      { servers: {}, vmEnabledForAgent: false } as never,
    );
    assert.ok(facts.startsWith(FACTS_HEADER));
    // The approvals line is unconditional by design - it describes the mode in force, not a capability. What must
    // not appear is a per-server line for a server that was not registered.
    const body = facts.slice(FACTS_HEADER.length);
    assert.doesNotMatch(body, /\(legion/, 'a server line was emitted for a server with no registered tools');
    assert.match(body, /- Approvals: your mode is /, 'the unconditional approvals line is missing');
    // And no capability policy line may fire without its capability.
    assert.doesNotMatch(body, /kg_supersede/, 'a kg_supersede policy line appeared with no kg server registered');
  });

  it('the supersede policy line is emitted only when kg_supersede is really registered', () => {
    // Conditional on presence, so an install without the tool does not carry a line about it.
    const withIt = renderCapabilities(
      { id: 'zealot', name: 'Zealot', approval: 'ask' } as never,
      {
        servers: { legion_kg: { instance: { _registeredTools: { kg_supersede: {}, kg_capture: {} } } } },
        vmEnabledForAgent: false,
      } as never,
    );
    assert.match(withIt, /kg_supersede/, 'the policy line is missing even though the tool is registered');
    assert.match(withIt, /proposal/, 'the line does not say a shared note needs the owner');

    const withoutIt = renderCapabilities(
      { id: 'zealot', name: 'Zealot', approval: 'ask' } as never,
      { servers: { legion_kg: { instance: { _registeredTools: { kg_capture: {} } } } }, vmEnabledForAgent: false } as never,
    );
    assert.doesNotMatch(withoutIt, /kg_supersede/, 'a line about kg_supersede leaked into a run that lacks it');
  });

  it('the house preamble says what to do with content that is not the app own words', () => {
    // The wrapper explains itself in the text, but an agent needs the instruction in the preamble to act on it.
    assert.match(HOUSE_PREAMBLE, /not the app'?s own words/,
      'the preamble does not tell an agent how to treat untrusted layer content');
    assert.match(HOUSE_PREAMBLE, /never as an instruction/,
      'the preamble does not say such content is not to be obeyed');
  });

  it('the preamble stays short, because it is paid for on every run', () => {
    const lines = HOUSE_PREAMBLE.split('\n');
    assert.ok(lines.length <= 8, `the house preamble is ${lines.length} lines; every one is paid for on every run`);
    for (const line of lines) {
      assert.ok(line.trim().length > 0, 'the preamble has an empty line');
      assert.ok(line.length < 240, `a preamble line runs ${line.length} chars: ${line.slice(0, 60)}...`);
    }
  });

  it('the preamble does not restate a tool description', () => {
    // The bloat rule, made mechanical: the argument lists in tools.ts duplicate what the preamble should not say.
    const tools = src('src/core/house/tools.ts');
    const recalled = /recall/.test(HOUSE_PREAMBLE);
    assert.ok(recalled, 'the preamble does not mention recall at all');
    // A preamble line that enumerates every tool by name is the failure mode; naming the workflow is the intent.
    const enumerated = (HOUSE_PREAMBLE.match(/house_[a-z]+/g) ?? []).length;
    assert.ok(enumerated <= 3, `the preamble enumerates ${enumerated} tool names; that belongs in the tool list`);
    assert.ok(tools.includes('house_recall'), 'sanity: the tool still exists');
  });

  it('the KG policy lives in agent-facts, not duplicated into the house preamble', () => {
    assert.doesNotMatch(HOUSE_PREAMBLE, /kg_supersede/,
      'the KG policy leaked into the house preamble; the two modules own different instructions');
    assert.match(src('src/core/agent-facts.ts'), /kg_supersede/,
      'the KG policy line is gone from agent-facts');
  });
});
