import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taintsRun, buildChildEnv } from '../src/core/engine.js';
import { defaultConfig, saveConfig } from '../src/shared/config.js';
import { createBsvState } from '../src/core/bsv/state.js';
import { needsApproval } from '../src/core/approvals.js';

test('R2-T1 taint classification of every real Claude Agent SDK / Claude Code tool name', () => {
  const clean = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode'];
  const mustTaint = ['Skill', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ListMcpResources', 'ReadMcpResource', 'mcp__github__get_issue', 'mcp__legion__vm_exec', 'mcp__legion__vm_read_file', 'mcp__legion__vm_claude', 'mcp__legion__vm_desktop', 'Mcp', 'TaskOutput', 'SlashCommand'];
  // 'Skill' moved from the clean list to must-taint on 2026-10-06 (Armory, plan-armory.md): a skill's text can come from a third party, so a Skill load
  // taints unless the skill it names is the owner's own or a Claude Code built-in. That is decided per load from the tool_use input in
  // Engine.noteToolUse (test/armory-taint.test.ts); taintsRun alone has no input, so it answers for the unknown case: taints.
  const shouldBeClean = ['AskUserQuestion', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch', 'Config', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronList', 'CronDelete', 'Monitor', 'mcp__legion__ask', 'mcp__legion__tell', 'mcp__legion__agents', 'mcp__legion__vm_start', 'mcp__legion__vm_write_file', 'mcp__legion__vm_stop', 'mcp__legion_comms__room_read', 'mcp__legion_kg__kg_recall', 'mcp__legion_kg__kg_capture'];
  const wrong: string[] = [];
  for (const t of clean) if (taintsRun(t)) wrong.push(`${t} should be clean`);
  for (const t of mustTaint) if (!taintsRun(t)) wrong.push(`${t} must taint`);
  const overTainted = shouldBeClean.filter((t) => taintsRun(t));
  console.log('R2-T1 WRONG', JSON.stringify(wrong), 'OVER-TAINTED legit tools', JSON.stringify(overTainted));
  assert.deepEqual(wrong, []);
  assert.deepEqual(overTainted, []);
});

test('R2-T2 prefix confusion: mcp__legion__ prefix match lets a server whose name merely starts with legion__ skip taint and approvals', () => {
  for (const t of ['mcp__legion__evil__run', 'mcp__legion_kg__x__run', 'mcp__legion_comms__x__run']) {
    assert.ok(taintsRun(t) || needsApproval('ask', t), `${t}: no taint and no approval`);
  }
});

test('R2-K1 buildChildEnv drops every env var that contains the token, in any variable name', () => {
  const cfg = defaultConfig();
  const prev = { ...process.env };
  try {
    process.env.SOME_VAR = `x${cfg.authToken}y`;
    process.env.LEGION_TOKEN = cfg.authToken;
    process.env.http_proxy = `http://user:${cfg.authToken}@proxy`;
    process.env.B64 = Buffer.from(cfg.authToken).toString('base64');
    process.env.UPPER = cfg.authToken.toUpperCase();
    const env = buildChildEnv(cfg);
    const left = Object.entries(env).filter(([, v]) => typeof v === 'string' && v.toLowerCase().includes(cfg.authToken.toLowerCase())).map(([k]) => k);
    console.log('R2-K1 still carrying token:', JSON.stringify(left), 'b64 kept:', 'B64' in env);
    assert.deepEqual(left, []);
  } finally { for (const k of ['SOME_VAR', 'LEGION_TOKEN', 'http_proxy', 'B64', 'UPPER']) delete process.env[k]; Object.assign(process.env, prev); }
});

test('R2-K2 config.json stays 0600 after the BSV toggle rewrites it (bsv/state.ts tmp+rename with default mode)', () => {
  if (process.platform === 'win32') return;
  const dir = cleanupTemp('r2k2-');
  process.env.LEGION_HOME = dir;
  saveConfig(defaultConfig());
  const f = join(dir, 'config.json');
  assert.equal(statSync(f).mode & 0o777, 0o600, 'precondition: saveConfig is 0600');
  const st = createBsvState({ dataDir: dir });
  st.set(true);
  const mode = statSync(f).mode & 0o777;
  console.log('R2-K2 mode after BSV toggle', mode.toString(8));
  assert.equal(mode, 0o600);
});
