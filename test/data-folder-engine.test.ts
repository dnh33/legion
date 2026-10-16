// test/data-folder-engine.test.ts: the engine asks the owner before a shell command works on Legion's own data folder
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setup } from './away-rig.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';
import type { ModeResolver } from '../src/core/gates-settings/index.js';

type Hook = (i: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } } | undefined>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DATA = join(homedir(), '.legion-guardtest');
const fwd = DATA.replace(/\\/g, '/');
const guardModule = { id: 'dataguard', protectedPaths: () => dataFolderTargets(DATA) } as never;

/** Runs commands through the PreToolUse hook that owns the shell floor's card for Claude's shell tools. A card is answered "no". */
async function viaHook(mode: 'ask' | 'auto-edits' | 'full', commands: Array<[string, string]>) {
  const modes: ModeResolver = { mode: () => mode };
  const r = setup({ approval: mode, modes });
  r.engine.setModules([guardModule]);
  const task = r.start('a1', 'go');
  const out: Array<{ command: string; card: boolean; noRemember: boolean; decision?: string }> = [];
  try {
    await pause(120);
    const pre = (r.calls[0]!.options as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Hook[] }> } }).hooks.PreToolUse;
    const hook = (mode === 'full' ? pre.filter((h) => h.matcher === '.*') : pre.filter((h) => /Bash/.test(String(h.matcher)))).flatMap((h) => h.hooks)[0]!;
    for (const [tool, command] of commands) {
      const p = hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } });
      await pause(30);
      const pend = r.approvals.pending();
      const card = pend.length > 0;
      const noRemember = card && pend[0]!.noRemember === true;
      if (card) r.approvals.resolve(pend[0]!.id, false);
      out.push({ command, card, noRemember, decision: (await p)?.hookSpecificOutput?.permissionDecision });
    }
  } finally { r.engine.cancel(task.id); }
  return out;
}

test('Ask and Auto-edits: mv, cp, rm and redirects on the data folder get a card with no Remember (the mv and cp probes included)', async () => {
  for (const mode of ['ask', 'auto-edits'] as const) {
    const out = await viaHook(mode, [
      ['Bash', `mv ${fwd}/gates/app.json C:/work/projB/x`],
      ['Bash', `cp C:/work/projB/old.json ${fwd}/gates/app.json`],
      ['PowerShell', `Move-Item ${DATA}\\gates\\app.json x`],
      ['mcp__host__shell', `mv ${fwd}/projects.json x`],
      ['Monitor', `mv ${fwd}/gates-key.bin x`],
      ['Bash', `rm ${fwd}/gates/app.json`],
      ['Bash', `echo {} > ${fwd}/gates/proj_aaaaaaaaaaaa.json`],
      ['Bash', 'mv $D/gates/app.json x'],
    ]);
    for (const o of out) { assert.equal(o.card, true, `${mode}: ${o.command}`); assert.equal(o.noRemember, true, `${mode}: no Remember: ${o.command}`); assert.equal(o.decision, 'deny'); }
  }
});

test('reading the data folder and plain work raise no folder card', async () => {
  const out = await viaHook('ask', [['Bash', `cat ${fwd}/projects.json`], ['Bash', 'mv a.txt b.txt'], ['Bash', `ls ${fwd}/gates`], ['PowerShell', `Get-Content ${DATA}\\state.json`], ['Bash', `cd ${fwd}/workspaces/builder && npm install`], ['Bash', `mkdir -p ${fwd}/workspaces/builder/notes && echo hi > ${fwd}/workspaces/builder/notes/a.md`]]);
  for (const o of out) assert.equal(o.card, false, o.command);
});

test('Bypass: no extra card (the one mode the owner chose to leave open)', async () => {
  const out = await viaHook('full', [['Bash', `mv ${fwd}/gates/app.json x`], ['Bash', `rm ${fwd}/gates/app.json`]]);
  for (const o of out) { assert.equal(o.card, false, o.command); assert.equal(o.decision, undefined); }
});

test('N29: Claude Code keeps its folder between shell calls: an unproven cd marks the rest of the run', async () => {
  for (const mode of ['ask', 'auto-edits'] as const) {
    // call 1 moves into the data folder (a read, free); call 2 is a relative write that means the data folder
    const out = await viaHook(mode, [['Bash', `cd ${fwd}`], ['Bash', 'rm gates/app.json'], ['PowerShell', 'Remove-Item gates\app.json']]);
    assert.equal(out[0]!.card, false, `${mode}: the cd itself only reads`);
    for (const o of out.slice(1)) { assert.equal(o.card, true, `${mode}: ${o.command}`); assert.equal(o.noRemember, true, `${mode}: no Remember: ${o.command}`); }
  }
});

test('N29: a run that only did cd into a folder outside the protected set keeps ordinary work free', async () => {
  const out = await viaHook('ask', [['Bash', 'cd C:/work/projB/sub'], ['Bash', 'rm build/x'], ['Bash', 'mv a.txt b.txt']]);
  for (const o of out) assert.equal(o.card, false, o.command);
});
