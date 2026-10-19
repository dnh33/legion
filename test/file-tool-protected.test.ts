// test/file-tool-protected.test.ts: the Claude file tools refuse Legion's own settings files in every spelling; workspaces stay writable
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { setup } from './away-rig.js';
import { tempDir } from './tmp-cleanup.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';

type Hook = (i: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } } | undefined>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const win = process.platform === 'win32';

async function refused(paths: Array<[string, string]>, data: string): Promise<Array<{ path: string; tool: string; denied: boolean }>> {
  const r = setup({ approval: 'auto-edits' });
  r.engine.setModules([{ id: 'dataguard', protectedPaths: () => dataFolderTargets(data) } as never]);
  const task = r.start('a1', 'go');
  const out: Array<{ path: string; tool: string; denied: boolean }> = [];
  try {
    await pause(120);
    const pre = (r.calls[0]!.options as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Hook[] }> } }).hooks.PreToolUse;
    for (const [tool, path] of paths) {
      let denied = false;
      for (const h of pre.flatMap((x) => x.hooks)) {
        const res = await h({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: path, notebook_path: path } });
        if (res?.hookSpecificOutput?.permissionDecision === 'deny') denied = true;
      }
      out.push({ path, tool, denied });
    }
  } finally { r.engine.cancel(task.id); }
  return out;
}

test('Write and Edit refuse every spelling of a protected file; a workspace file stays writable', { skip: !win }, async () => {
  const root = tempDir('legion-ftp-');
  const data = join(root, 'Fake Data');
  mkdirSync(join(data, 'gates'), { recursive: true });
  mkdirSync(join(data, 'workspaces', 'builder'), { recursive: true });
  writeFileSync(join(data, 'state.json'), '{}');
  symlinkSync(data, join(root, 'junc'), 'junction');
  const drive = data.slice(0, 1);
  const rest = data.slice(2);
  const share = (h: string): string => `\\\\${h}\\${drive}$${rest}\\state.json`;
  const bad = [
    join(data, 'state.json'), join(data, 'gates', 'app.json'), join(data, 'gates-key.bin'), join(data, 'config.json'), join(data, 'projects.json'),
    share('localhost'), share('127.0.0.1'), share('[::1]'), share(hostname()), `//localhost/${drive}$${rest.replace(/\\/g, '/')}/state.json`,
    `\\\\?\\${join(data, 'state.json')}`, `\\\\?\\UNC\\localhost\\${drive}$${rest}\\state.json`, `${data}\\state.json.`, `${data}\\state.json `, `${data}\\workspaces\\..\\state.json`,
    join(root, 'junc', 'state.json'), join(root, 'junc', 'gates', 'new.json'), '\\\\?\\Volume{1234}\\x',
  ];
  const res = await refused(bad.flatMap((p) => [['Write', p], ['Edit', p]] as Array<[string, string]>), data);
  for (const o of res) assert.equal(o.denied, true, `${o.tool} ${o.path}`);
  const ok = await refused([['Write', join(data, 'workspaces', 'builder', 'notes.md')], ['Edit', join(data, 'workspaces', 'builder', 'a', 'b.ts')], ['Write', join(root, 'elsewhere.txt')]], data);
  for (const o of ok) assert.equal(o.denied, false, `${o.tool} ${o.path}`);
});

test('N16b, N27, N31: own-address shares, a hardlink to a protected file and the connectors folder are refused', { skip: !win }, async () => {
  const root = tempDir('legion-ftp2-');
  const data = join(root, 'Fake Data');
  const ws = join(data, 'workspaces', 'builder');
  mkdirSync(join(data, 'connectors'), { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(data, 'config.json'), '{}');
  const hard = join(ws, 'h.json');
  execFileSync('cmd', ['/c', 'fsutil', 'hardlink', 'create', hard, join(data, 'config.json')], { stdio: 'ignore' });
  const rest = data.slice(2);
  const own = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal)
    .map((a) => (a!.family === 'IPv6' ? `${a!.address.replace(/:/g, '-').replace(/%/g, 's')}.ipv6-literal.net` : a!.address));
  const bad = [...own, '127.0.0.2'].map((h) => `\\\\${h}\\${data.slice(0, 1)}$${rest}\\config.json`);
  bad.push(hard, join(data, 'connectors', 'key.bin'), join(data, 'providers', 'keys.json'), join(data, 'providers', 'new.json'));
  const res = await refused(bad.map((p) => ['Write', p] as [string, string]), data);
  for (const o of res) assert.equal(o.denied, true, `${o.tool} ${o.path}`);
  const ok = await refused([['Write', join(ws, 'plain.json')]], data);
  assert.equal(ok[0]!.denied, false);
});
