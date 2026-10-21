/**
 * Claude Agent SDK 0.3.302 turned fork subagents (subagent_type "fork") on by default in SDK sessions. Legion keeps them off in
 * 0.3.7 (owner, 2026-10-21): the release that brings that SDK is a security update and must not change how agents work; 0.3.8 tests
 * forks with Legion's cards, task counting and cost and then follows Claude's default. CLAUDE_CODE_FORK_SUBAGENT=0 is the SDK's own
 * switch (its CHANGELOG, 0.3.302); a value the owner set in their own environment wins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildChildEnv } from '../src/core/engine.js';
import { defaultConfig } from '../src/shared/config.js';
import { tempDir } from './tmp-cleanup.js';

const cfg = () => { const c = defaultConfig(); c.workspaceDir = join(tempDir('legion-fork-'), 'ws'); return c; };

test('every Claude run starts with fork subagents off', () => {
  const before = process.env.CLAUDE_CODE_FORK_SUBAGENT;
  delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
  try {
    assert.equal(buildChildEnv(cfg()).CLAUDE_CODE_FORK_SUBAGENT, '0');
    assert.equal(buildChildEnv(cfg(), { probe: true }).CLAUDE_CODE_FORK_SUBAGENT, '0');
    assert.equal(buildChildEnv(cfg(), { scrub: false }).CLAUDE_CODE_FORK_SUBAGENT, '0');
  } finally { if (before === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT; else process.env.CLAUDE_CODE_FORK_SUBAGENT = before; }
});

test('the owner can turn fork subagents on with their own environment variable', () => {
  const before = process.env.CLAUDE_CODE_FORK_SUBAGENT;
  process.env.CLAUDE_CODE_FORK_SUBAGENT = '1';
  try {
    assert.equal(buildChildEnv(cfg()).CLAUDE_CODE_FORK_SUBAGENT, '1');
  } finally { if (before === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT; else process.env.CLAUDE_CODE_FORK_SUBAGENT = before; }
});
