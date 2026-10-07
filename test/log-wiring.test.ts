/** Logging wired in (PR 2): import order, split tokens, events, admin routes, the start-failure line. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { isClientRoute } from '../src/core/admin.js';
import { EventBus } from '../src/core/bus.js';
import { attachLogEvents } from '../src/core/log/events.js';
import { createLogsModule, openLogSink } from '../src/core/log/index.js';
import { LogSink } from '../src/core/log/logger.js';
import { redact } from '../src/core/log/redact.js';
import { installStreamWrappers, TAIL_CAP, TAIL_KEEP } from '../src/core/log/stream-wrap.js';
import { startFailureLine } from '../src/electron/resolve-node.js';
import { LOGS_DESCRIPTION } from '../src/shared/logs.js';
import type { Task } from '../src/shared/types.js';
import { AUTH, asClient } from './helpers-c.js';
import { closeAll, mount, until } from './token-harness.js';
import { tempDir } from './tmp-cleanup.js';

after(closeAll);

// Built at runtime so the public export's secret scan does not see key-shaped literals in this file.
const GHP = 'gh' + 'p_' + 'c'.repeat(36);
const GHP2 = 'gh' + 'p_' + 'd'.repeat(36);
const MARKER = 'MARKER-' + 'zq81xk3v';
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const allLogText = (dir: string): string => (existsSync(dir) ? readdirSync(dir).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n') : '');

type W = (c: unknown, e?: unknown, cb?: unknown) => boolean;
function fake(): { chunks: string[]; write: W } {
  const s = { chunks: [] as string[], write: (() => true) as W };
  s.write = (c, e, cb) => {
    s.chunks.push(typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('utf8'));
    const f = [e, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
    f?.();
    return true;
  };
  return s;
}

test('the stream wrappers are the very first import of legion-core.ts, and nothing else writes core.log', () => {
  const core = src('src/bin/legion-core.ts');
  const code = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const firstImport = /^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/m.exec(code);
  assert.equal(firstImport?.[1], '../core/log/install.js');
  assert.equal(/appendFileSync/.test(core), false, 'one writer: log() goes through the logger');
  assert.match(src('src/core/log/install.ts'), /installStreamWrappers\(\);/);
});

test('a token split across two writes comes out masked, and the tail is flushed on a timer', async () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 10, onExit: false });
  out.write('line one ' + GHP2 + '\ntoken ' + GHP.slice(0, 20));
  out.write(GHP.slice(20) + ' end');
  assert.equal(out.chunks.join('').includes('gh' + 'p_'), false, 'nothing unmasked so far');
  await new Promise((r) => setTimeout(r, 80));
  const text = out.chunks.join('');
  assert.equal(text.includes(GHP.slice(0, 20)), false);
  assert.equal(text.includes('gh' + 'p_'), false, 'the emitted part is redacted too');
  assert.match(text, /line one \[redacted-token\]\n/);
  assert.match(text, /token \[redacted-token\] end/);
  restore();
});

test('the tail is flushed synchronously by restore (the exit path) and the callback runs when nothing is emitted', async () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 60_000, onExit: false });
  let called = 0;
  out.write('no newline yet ' + GHP, () => { called++; });
  assert.equal(out.chunks.length, 0, 'held');
  await new Promise((r) => setImmediate(r));
  assert.equal(called, 1);
  restore();
  assert.equal(out.chunks.join('').includes(GHP), false);
  assert.match(out.chunks.join(''), /no newline yet \[redacted-token\]/);
});

test('a line past the cap emits all but the last 256 characters and holds those', () => {
  const out = fake();
  const restore = installStreamWrappers([out as never], { flushMs: 60_000, onExit: false });
  out.write('a'.repeat(TAIL_CAP + 1000));
  assert.equal(out.chunks.join('').length, TAIL_CAP + 1000 - TAIL_KEEP);
  restore();
  assert.equal(out.chunks.join('').length, TAIL_CAP + 1000);
});

test('startFailureLine goes through the redactor before it is appended (main.ts)', () => {
  const line = redact(startFailureLine(`spawn failed token ${GHP}`));
  assert.equal(line.includes('gh' + 'p_'), false);
  assert.match(src('src/electron/main.ts'), /appendFileSync\(join\(dataDir\(\), 'core\.log'\), redact\(startFailureLine\(err\)\)\)/);
});

test('bus events: run.finished and approvals carry fixed fields only, never text', () => {
  const dir = tempDir('legion-log-');
  const sink = new LogSink({ dir });
  const bus = new EventBus();
  let clock = 1000;
  const detach = attachLogEvents(bus, sink, () => clock);
  const task = (status: Task['status']): Task => ({ id: 't1', agentId: 'scout', title: MARKER, status, source: 'ui', requestedModel: 'auto', model: 'sonnet', turns: 7, result: MARKER, createdAt: 'x', updatedAt: 'x' } as Task);
  bus.emit({ type: 'task.updated', task: task('running') });
  bus.emit({ type: 'message', message: { id: 'm', taskId: 't1', role: 'assistant', text: MARKER, at: 'x' } });
  bus.emit({ type: 'message.delta', taskId: 't1', text: MARKER });
  bus.emit({ type: 'approval.requested', approval: { id: 'a1', taskId: 't1', agentId: 'scout', toolName: 'Bash', summary: MARKER, input: { command: MARKER }, at: 'x' } });
  bus.emit({ type: 'approval.resolved', approvalId: 'a1', allowed: false });
  clock = 42_000;
  bus.emit({ type: 'task.updated', task: task('done') });
  bus.emit({ type: 'task.updated', task: { ...task('done'), archived: true } }); // a later edit is not a second finish
  detach();
  sink.flushSync(); sink.closeAll();
  const agents = readFileSync(join(dir, 'agents.log'), 'utf8');
  assert.match(agents, /run\.finished agent="scout" provider="claude" model="sonnet" ms=41000 turns=7 outcome="ok"/);
  assert.equal(agents.match(/run\.finished/g)?.length, 1);
  assert.match(agents, /approval\.asked agent="scout" tool="Bash"/);
  assert.match(agents, /approval\.answered allowed=false/);
  assert.equal(allLogText(dir).includes(MARKER), false);
});

test('a real run with a marker in its prompt and its messages leaves the marker in no log file', async () => {
  let sinkDir = '';
  const m = await mount(undefined, { extraModules: (deps) => { const sink = openLogSink(deps.dataDir); sinkDir = sink.dir; return [createLogsModule(deps, { sink })]; } });
  const started = await m.http('POST', '/api/tasks', { agentId: 'worker', prompt: `please do ${MARKER} now` }, AUTH);
  assert.equal(started.status, 201);
  await until(() => m.store.getTask(started.json.id)?.status === 'done');
  await new Promise((r) => setTimeout(r, 50));
  await m.modules.find((x) => x.id === 'logs')!.dispose?.();
  const text = allLogText(sinkDir);
  assert.match(text, /run\.started agent="worker"/);
  assert.match(text, /run\.finished agent="worker"[^\n]*outcome="ok"/);
  assert.equal(text.includes(MARKER), false);
});

test('the log routes are admin-only: not on the client list, 403 for the bearer token alone, 200 for the app', async () => {
  for (const [meth, p] of [['GET', '/api/logs'], ['POST', '/api/logs/clear'], ['GET', '/api/logs/errors']] as const) assert.equal(isClientRoute(meth, p), false, `${meth} ${p}`);
  const m = await mount(undefined, { extraModules: (deps) => [createLogsModule(deps, { sink: openLogSink(deps.dataDir) })] });
  assert.equal((await m.http('GET', '/api/logs', undefined, asClient)).status, 403);
  assert.equal((await m.http('POST', '/api/logs/clear', undefined, asClient)).status, 403);
  assert.equal((await m.http('GET', '/api/logs/errors', undefined, asClient)).status, 403);
  const ok = await m.http('GET', '/api/logs', undefined, AUTH);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.description, LOGS_DESCRIPTION);
  assert.equal(ok.json.dir, join(m.dataDir, 'logs'));
});

test('Clear logs deletes the files while the writer is open, then logging goes on; Copy errors returns the tail', async () => {
  let sink!: LogSink;
  const m = await mount(undefined, { extraModules: (deps) => { sink = openLogSink(deps.dataDir); return [createLogsModule(deps, { sink })]; } });
  sink.logger('core').error('core.crash', { message: 'boom ' + GHP });
  sink.logger('core').info('before.clear');
  const errs = await m.http('GET', '/api/logs/errors', undefined, AUTH);
  assert.match(errs.json.text, /core\.crash/);
  assert.equal(errs.json.text.includes(GHP), false);
  assert.equal(errs.json.text.includes('before.clear'), false, 'errors.log holds WARN and above only');
  const listed = await m.http('GET', '/api/logs', undefined, AUTH);
  assert.ok(listed.json.files.some((f: { name: string; bytes: number }) => f.name === 'errors.log' && f.bytes > 0));
  const cleared = await m.http('POST', '/api/logs/clear', undefined, AUTH);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.files, []);
  assert.equal(existsSync(join(sink.dir, 'legion.log')), false);
  sink.logger('core').info('after.clear');
  sink.flushSync();
  const text = readFileSync(join(sink.dir, 'legion.log'), 'utf8');
  assert.match(text, /after\.clear/);
  assert.equal(text.includes('before.clear'), false);
  sink.closeAll();
});

test('the Logs copy leads with the benefit and uses no tracking words', () => {
  assert.match(LOGS_DESCRIPTION, /^Legion keeps a short record of what it did/);
  assert.match(LOGS_DESCRIPTION, /never sent anywhere/);
  assert.equal(/diagnostic|analytics|telemetry/i.test(LOGS_DESCRIPTION), false);
  assert.equal(/diagnostic|analytics|telemetry/i.test(src('ui/src/logs/LogsSection.tsx')), false);
});
