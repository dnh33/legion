/**
 * Every Python Legion starts for Blender runs in UTF-8 mode. On Windows Python's stdout is the ANSI code page (cp1252), so a script or a
 * reply with U+2028 or an emoji raised UnicodeEncodeError (the 'wrapLive: defines LEGION_EXPORT_DIR' flake). The cp1252 locale is simulated
 * with PYTHONIOENCODING=cp1252 PYTHONUTF8=0 in THIS process's environment, which the product's spawn paths inherit and must override.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PYTHON_UTF8_ENV } from '../src/core/blender/backend.js';
import { serverEnv } from '../src/core/blender/backends/official.js';
import { wrapLive } from '../src/core/blender/guard.js';
import { createRealIo } from '../src/core/blender/system.js';
import { tmp } from './blender-helpers.js';

const python = ['python3', 'python'].find((c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const SPICY = 'café   😀 中';

async function underCp1252<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { a: process.env.PYTHONIOENCODING, b: process.env.PYTHONUTF8 };
  process.env.PYTHONIOENCODING = 'cp1252';
  process.env.PYTHONUTF8 = '0';
  try { return await fn(); } finally {
    for (const [k, v] of [['PYTHONIOENCODING', saved.a], ['PYTHONUTF8', saved.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the MCP server environment forces UTF-8 for Python and a configured value cannot turn it off', () => {
  const e = serverEnv({ PYTHONUTF8: '0', PYTHONIOENCODING: 'cp1252', A: 'b' });
  assert.equal(e.PYTHONUTF8, '1');
  assert.equal(e.PYTHONIOENCODING, 'utf-8');
  assert.equal(e.A, 'b');
  assert.deepEqual({ ...PYTHON_UTF8_ENV }, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
});

test('run(): a program that prints U+2028 and an emoji works under a cp1252 locale, and the output is read as UTF-8', { skip: !python && 'python is not installed' }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'bpy.py'), 'ops = None\n');
  const script = `print(${JSON.stringify(SPICY)})\nprint("dir", LEGION_EXPORT_DIR)\n`;
  writeFileSync(join(dir, 'w.py'), wrapLive(script, join(dir, 'blender-exports')));
  // control: the simulated locale really breaks Python without the product's environment
  const bare = await underCp1252(async () => { try { execFileSync(python!, [join(dir, 'w.py')], { env: { ...process.env, PYTHONPATH: dir }, stdio: 'pipe' }); return 0; } catch { return 1; } });
  assert.equal(bare, 1, 'the simulated cp1252 locale must break a bare python (otherwise this test proves nothing)');
  const r = await underCp1252(() => createRealIo().run(python!, [join(dir, 'w.py')], 20_000, { env: { PYTHONPATH: dir } }));
  assert.ok(r, 'python started');
  assert.equal(r!.code, 0, r!.stderr);
  assert.ok(r!.stdout.includes(SPICY), JSON.stringify(r!.stdout));
});

test('spawnDetached(): the started program has the UTF-8 variables too, whatever the parent had', { skip: !python && 'python is not installed' }, async () => {
  const dir = tmp();
  const out = join(dir, 'env.txt');
  await underCp1252(async () => {
    createRealIo().spawnDetached(python!, ['-c', `import os;open(${JSON.stringify(out)},"w").write(os.environ["PYTHONUTF8"]+"|"+os.environ["PYTHONIOENCODING"])`]);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
  });
  assert.equal(readFileSync(out, 'utf8'), '1|utf-8');
});
