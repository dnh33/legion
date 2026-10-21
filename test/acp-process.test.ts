import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { RpcPeer } from '../src/core/acp/rpc.js';
import { clearRegisteredSecrets, registerSecret } from '../src/core/log/redact.js';
import type { AcpEntry } from '../src/shared/acp-view.js';
import {
  AgentLaunchError, addLegionSecret, buildAgentEnv, forgetLegionSecrets, imageOf, cmdLine, killAllAgentsSync, killPid, killPidSync, launchSpec, registerLegionSecrets, resolveCommand,
  runAgentCli, startAgentProcess, sweepStaleAgents, type AgentProcess,
} from '../src/core/acp/process.js';

registerLegionSecrets([]); // the agent host refuses to start anything until the core has registered its secrets
const FAKE = fileURLToPath(new URL('./acp-fake-agent.js', import.meta.url));
const WIN = process.platform === 'win32';
const started: AgentProcess[] = [];
const extraPids = new Set<number>();

const entry = (mode: string, extra: string[] = [], over: Partial<AcpEntry> = {}): AcpEntry => ({
  id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE, '--mode', mode, ...extra], tested: false, enabled: true, ...over,
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), ms); })]); } finally { clearTimeout(t); }
};
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(25); }
}
function begin(e: AcpEntry, o: { stripSkipFlags?: boolean; extraEnv?: Record<string, string>; dataDir?: string; cwd?: string } = {}): AgentProcess {
  const p = startAgentProcess(e, { cwd: o.cwd ?? tempDir('acp-cwd-'), stripSkipFlags: o.stripSkipFlags ?? false, dataDir: o.dataDir ?? tempDir('acp-data-'), ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}) });
  started.push(p);
  return p;
}
async function handshake(p: AgentProcess) {
  const peer = new RpcPeer(p.io, { requestTimeoutMs: 15_000 });
  const init = await peer.request<{ agentInfo: { version: string } }>('initialize', { protocolVersion: 1, clientCapabilities: {} });
  return { peer, init };
}
function reportOf(file: string): Record<string, any> { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>; }
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

after(async () => {
  for (const p of started) p.killNow();
  for (const pid of extraPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await Promise.all(started.map((p) => Promise.race([p.exited, sleep(3000)])));
  registerLegionSecrets([]);
  clearRegisteredSecrets();
});

// ---------------------------------------------------------------- launch options

test('spawn: shell false, windowsHide, not detached, piped stdio, the working folder given', () => {
  const calls: Array<{ file: string; args: readonly string[]; options: Record<string, any> }> = [];
  const child = Object.assign(new EventEmitter(), { pid: 2_000_000_001, exitCode: null as number | null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  const cwd = tempDir('acp-cwd-');
  const p = startAgentProcess(entry('ok'), { cwd, stripSkipFlags: false, dataDir: tempDir('acp-data-') }, {
    spawn: (file, args, options) => { calls.push({ file, args, options: options as Record<string, any> }); return child as unknown as ChildProcess; },
  });
  try {
    assert.equal(calls.length, 1);
    const o = calls[0]!.options;
    assert.equal(o.shell, false);
    assert.equal(o.windowsHide, true);
    assert.ok(!o.detached, 'not detached');
    assert.deepEqual(o.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(o.cwd, cwd);
    assert.equal(calls[0]!.file, process.execPath);
    assert.deepEqual(calls[0]!.args, [FAKE, '--mode', 'ok']);
    assert.equal(p.pid, 2_000_000_001);
  } finally { child.exitCode = 0; child.emit('exit', 0, null); } // leave the registry, or the exit hook would try to kill that PID
});

test('contained entry starts with -p legion acp', () => {
  const calls: string[][] = [];
  const child = Object.assign(new EventEmitter(), { pid: 2_000_000_002, exitCode: null as number | null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  startAgentProcess({ ...entry('ok'), args: ['acp'], contained: true }, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') }, {
    spawn: (_f, args) => { calls.push([...args]); return child as unknown as ChildProcess; },
  });
  child.exitCode = 0; child.emit('exit', 0, null);
  assert.deepEqual(calls[0], ['-p', 'legion', 'acp']);
});

// ---------------------------------------------------------------- command resolution

test('resolve: a bare name is looked up on PATH only, never in the working folder', () => {
  const planted = tempDir('acp-planted-');
  const onPath = tempDir('acp-path-');
  const file = WIN ? 'plantedprog.cmd' : 'plantedprog';
  writeFileSync(join(planted, file), WIN ? '@echo off\r\n' : '#!/bin/sh\n');
  if (!WIN) chmodSync(join(planted, file), 0o755);
  // the folder holding the file is the working folder, not on PATH: not found
  assert.throws(() => startAgentProcess({ ...entry('ok'), command: 'plantedprog' }, { cwd: planted, stripSkipFlags: false, dataDir: tempDir('acp-data-') }),
    (e) => e instanceof AgentLaunchError && e.code === 'not-found');
  // empty and "." entries on PATH do not add the working folder
  assert.throws(() => resolveCommand('plantedprog', { PATH: ['', '.', onPath].join(delimiter) }), (e) => e instanceof AgentLaunchError && e.code === 'not-found');
  // once its folder is on PATH it resolves
  assert.equal(resolveCommand('plantedprog', { PATH: [onPath, planted].join(delimiter) }), join(planted, file));
});

test('resolve: a relative path is refused', () => {
  assert.throws(() => resolveCommand('./hermes', { PATH: '' }), (e) => e instanceof AgentLaunchError && e.code === 'refused');
  assert.throws(() => resolveCommand('bin/hermes', { PATH: '' }), (e) => e instanceof AgentLaunchError && e.code === 'refused');
});

test('startAgentProcess: a missing program is a not-found error and starts nothing', () => {
  const dataDir = tempDir('acp-data-');
  assert.throws(() => startAgentProcess({ ...entry('ok'), command: 'definitely-not-installed-acp-agent' }, { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir }),
    (e) => e instanceof AgentLaunchError && e.code === 'not-found');
  assert.ok(!existsSync(join(dataDir, 'acp-pids.json')));
});

// ---------------------------------------------------------------- cmd.exe launches

test('cmdLine: every part quoted, trailing backslashes doubled, unsafe characters refused', () => {
  assert.equal(cmdLine('C:\\a b\\x.cmd', ['acp', '-p', 'my profile']), '"C:\\a b\\x.cmd" "acp" "-p" "my profile"');
  assert.equal(cmdLine('C:\\x.cmd', ['C:\\dir\\', 'C:\\dir\\\\']), '"C:\\x.cmd" "C:\\dir\\\\" "C:\\dir\\\\\\\\"');
  assert.equal(cmdLine('C:\\x.cmd', ['']), '"C:\\x.cmd" ""');
  assert.equal(cmdLine('C:\\Users\\Jørgen (work)\\x.cmd', ['--name=Æbleskiver']), '"C:\\Users\\Jørgen (work)\\x.cmd" "--name=Æbleskiver"');
  for (const bad of ['a&b', 'x & echo pwned > marker', 'a|b', 'a<b', 'a>b', 'a^b', '"quoted"', '%PATH%', '!x!', 'a\nb', 'a\rb', 'a\0b', '$(x)', '`x`']) {
    assert.throws(() => cmdLine('C:\\x.cmd', [bad]), (e) => e instanceof AgentLaunchError && e.code === 'refused', `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => cmdLine('C:\\bad&dir\\x.cmd', []), (e) => e instanceof AgentLaunchError && e.code === 'refused');
});

test('cmd.exe launch (Windows): a .cmd file in a folder with spaces runs, the arguments arrive literally, nothing is injected', { skip: !WIN }, async () => {
  const dir = join(tempDir('acp-cmd-'), 'dir with spaces (x)');
  mkdirSync(dir, { recursive: true });
  const cmdFile = join(dir, 'agent.cmd');
  writeFileSync(cmdFile, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
  const report = join(dir, 'report file.json');
  const spec = launchSpec(cmdFile, ['--mode', 'ok'], { PATH: '' });
  assert.match(spec.file, /System32[\\/]cmd\.exe$/i);
  assert.deepEqual(spec.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
  assert.equal(spec.windowsVerbatimArguments, true);

  const p = begin({ ...entry('ok'), command: cmdFile, args: ['--mode', 'ok', '--report', report] });
  const { init } = await handshake(p);
  assert.equal(init.agentInfo.version, '0.0.1-fake');
  const r = reportOf(report);
  assert.deepEqual(r.argv, ['--mode', 'ok', '--report', report]);
  assert.notEqual(p.pid, r.pid, 'the recorded PID is cmd.exe, not the agent');
  // closing stdin ends the agent behind cmd.exe, and cmd.exe goes with it
  await within(p.stop(5000), 10_000, 'stop');
  await waitFor(() => !alive(r.pid), 5000);

  // an argument that tries to run a second command never reaches cmd.exe
  const marker = join(dir, 'pwned.txt');
  assert.throws(() => startAgentProcess({ ...entry('ok'), command: cmdFile, args: ['x & echo pwned > "' + marker + '"'] }, { cwd: dir, stripSkipFlags: false, dataDir: tempDir('acp-data-') }),
    (e) => e instanceof AgentLaunchError && e.code === 'refused');
  assert.ok(!existsSync(marker));
});

test('runAgentCli (Windows): a .cmd with spaces in its path runs with quoted arguments', { skip: !WIN }, async () => {
  const dir = join(tempDir('acp-cmd-'), 'cli dir');
  mkdirSync(dir, { recursive: true });
  const cmdFile = join(dir, 'tool.cmd');
  writeFileSync(cmdFile, '@echo off\r\necho %*\r\n');
  const r = await runAgentCli(cmdFile, ['a b', 'c'], { timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '"a b" "c"');
  const bad = await runAgentCli(cmdFile, ['a&b'], { timeoutMs: 10_000 });
  assert.equal(bad.code, null);
  assert.match(bad.stderr, /cmd\.exe/);
});

// ---------------------------------------------------------------- environment

test('env: pass-through of the user environment, minus Legion control variables and Legion secrets, plus entry and extra env', async () => {
  const token = 'tok_0123456789abcdef0123456789abcdef';
  const admin = 'adm_fedcba9876543210fedcba9876543210';
  registerLegionSecrets([token, admin]);
  await withEnv({ LEGION_PORT: '4747', LEGION_HOME: 'C:\\legion', HERMES_HOME: 'C:\\hh', OPENAI_API_KEY: 'sk-user-key-1234', CLAUDECODE: '1', HOLDS_TOKEN: `x-${token.toUpperCase()}-y`, HOLDS_ADMIN: `${admin}`, PLAIN_VAR: 'plain' }, async () => {
    const report = join(tempDir('acp-rep-'), 'r.json');
    const p = begin({ ...entry('ok', ['--report', report]), env: { FROM_ENTRY: 'e', PLAIN_VAR: 'overridden' } }, { extraEnv: { FROM_EXTRA: 'x' } });
    await handshake(p);
    const env = reportOf(report).env as Record<string, string>;
    assert.equal(env.HERMES_HOME, 'C:\\hh');
    assert.equal(env.OPENAI_API_KEY, 'sk-user-key-1234', 'the agent reads its own provider keys');
    assert.equal(env.FROM_ENTRY, 'e');
    assert.equal(env.FROM_EXTRA, 'x');
    assert.equal(env.PLAIN_VAR, 'overridden');
    for (const k of ['LEGION_PORT', 'LEGION_HOME', 'CLAUDECODE', 'HOLDS_TOKEN', 'HOLDS_ADMIN']) assert.ok(!(k in env), `${k} is not passed`);
    for (const v of Object.values(env)) assert.ok(!v.toLowerCase().includes(token.toLowerCase()) && !v.includes(admin), 'no value holds a Legion secret');
  });
  registerLegionSecrets([]);
});

test('env: stripSkipFlags false passes the skip flags, true removes all five', async () => {
  const flags = { HERMES_YOLO_MODE: '1', HERMES_IGNORE_RULES: '1', HERMES_SAFE_MODE: '1', HERMES_IGNORE_USER_CONFIG: '1', HERMES_ACCEPT_HOOKS: '1' };
  await withEnv({ ...flags, HERMES_HOME: 'C:\\hh' }, async () => {
    const r1 = join(tempDir('acp-rep-'), 'r.json');
    const p1 = begin(entry('ok', ['--report', r1]), { stripSkipFlags: false });
    await handshake(p1);
    for (const k of Object.keys(flags)) assert.equal((reportOf(r1).env as Record<string, string>)[k], '1', `${k} passes through`);

    const r2 = join(tempDir('acp-rep-'), 'r.json');
    const p2 = begin({ ...entry('ok', ['--report', r2]), env: { HERMES_YOLO_MODE: '1' } }, { stripSkipFlags: true, extraEnv: { HERMES_SAFE_MODE: '1' } });
    await handshake(p2);
    const env = reportOf(r2).env as Record<string, string>;
    for (const k of Object.keys(flags)) assert.ok(!(k in env), `${k} is removed`);
    assert.equal(env.HERMES_HOME, 'C:\\hh');
  });
});

test('buildAgentEnv: names match without regard to case on Windows', () => {
  const env = buildAgentEnv({ base: { Hermes_Yolo_Mode: '1', Path: 'p' }, extraEnv: { PATH: 'q' }, stripSkipFlags: true, platform: 'win32' });
  assert.deepEqual(env, { PATH: 'q' });
});

// ---------------------------------------------------------------- stop and kill

test('stop: closes stdin, waits the grace time, kills the PID and leaves the background service running', async () => {
  const report = join(tempDir('acp-rep-'), 'r.json');
  const p = begin(entry('hang', ['--daemon', '--report', report]));
  await handshake(p);
  const { daemonPid } = reportOf(report) as { daemonPid: number };
  extraPids.add(daemonPid); // before any assert, so a failure cannot leak the detached sleeper
  assert.ok(alive(daemonPid) && alive(p.pid));
  const t0 = Date.now();
  await within(p.stop(400), 10_000, 'stop');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 350, `waited the grace time (${elapsed} ms)`);
  assert.ok(!alive(p.pid), 'the agent is killed');
  assert.ok(alive(daemonPid), 'the background service is not (no tree kill)');
  const ex = await within(p.exited, 3000, 'exited');
  assert.ok(ex.code !== 0 || ex.signal !== null, 'killed, not a clean exit');
});

test('stop: an agent that leaves when stdin closes is not killed and stop returns early', async () => {
  const p = begin(entry('ok'));
  await handshake(p);
  const t0 = Date.now();
  await within(p.stop(8000), 10_000, 'stop');
  assert.ok(Date.now() - t0 < 5000, 'returned before the grace time');
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  await p.stop(); // twice is fine
});

test('killNow and killAllAgentsSync kill the PIDs of every agent this core started, now', async () => {
  const dataDir = tempDir('acp-data-');
  const a = begin(entry('hang'), { dataDir });
  const b = begin(entry('hang'), { dataDir });
  const c = begin(entry('hang'), { dataDir });
  await Promise.all([a, b, c].map(handshake));
  assert.deepEqual(new Set(JSON.parse(readFileSync(join(dataDir, 'acp-pids.json'), 'utf8')).agents.map((r: { pid: number }) => r.pid)), new Set([a.pid, b.pid, c.pid]));
  a.killNow();
  await within(a.exited, 5000, 'a exited');
  killAllAgentsSync();
  await within(Promise.all([b.exited, c.exited]), 8000, 'b and c exited');
  for (const p of [a, b, c]) assert.ok(!alive(p.pid));
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'acp-pids.json'), 'utf8')).agents, []);
});

test('killPid never touches a PID after the child exited (PID reuse guard)', async () => {
  const decoy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  extraPids.add(decoy.pid!);
  await waitFor(() => decoy.pid !== undefined && alive(decoy.pid));
  await killPid({ pid: decoy.pid, exitCode: 0, signalCode: null });
  killPidSync({ pid: decoy.pid, exitCode: null, signalCode: 'SIGTERM' });
  assert.ok(alive(decoy.pid!), 'the decoy is still alive');
  const done = new Promise<void>((r) => decoy.once('exit', () => r()));
  await killPid(decoy);
  await within(done, 5000, 'decoy killed when it is live');
});

// ---------------------------------------------------------------- pid file and sweep

test('pid file: written at start with the program image, removed at exit, no temp file left behind', async () => {
  const dataDir = tempDir('acp-data-');
  const p = begin(entry('ok'), { dataDir });
  const rec = JSON.parse(readFileSync(join(dataDir, 'acp-pids.json'), 'utf8')) as { agents: Array<{ pid: number; startedAt: number; image: string }> };
  assert.equal(rec.agents.length, 1);
  assert.equal(rec.agents[0]!.pid, p.pid);
  assert.ok(Math.abs(rec.agents[0]!.startedAt - Date.now()) < 5000);
  assert.equal(rec.agents[0]!.image, imageOf(process.execPath));
  await handshake(p);
  await p.stop();
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'acp-pids.json'), 'utf8')).agents, []);
  assert.deepEqual(readdirSync(dataDir), ['acp-pids.json'], 'written by temp file and rename: nothing else is left');
});

const sleeperProc = () => { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }); extraPids.add(c.pid!); return c; };
const pidFile = (dataDir: string) => join(dataDir, 'acp-pids.json');
const NODE_IMAGE = imageOf(process.execPath);

test('sweep: a recorded PID that is gone is dropped; a live one of ours is killed; a live PID that is not ours is left alone', async () => {
  const dataDir = tempDir('acp-data-');
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((r) => gone.once('exit', () => r()));
  const ours = sleeperProc();
  const stranger = sleeperProc();
  await waitFor(() => alive(ours.pid!) && alive(stranger.pid!));
  const now = Date.now();
  writeFileSync(pidFile(dataDir), JSON.stringify({ version: 1, agents: [
    { pid: gone.pid, startedAt: now - 1000, image: NODE_IMAGE },
    { pid: ours.pid, startedAt: now, image: NODE_IMAGE },
    { pid: stranger.pid, startedAt: now - 3_600_000, image: NODE_IMAGE }, // another program that reuses the PID: started at another time
  ] }));
  const ourExit = new Promise<void>((r) => ours.once('exit', () => r()));
  const res = sweepStaleAgents(dataDir);
  assert.deepEqual(res.killed, [ours.pid]);
  assert.deepEqual([...res.dropped].sort(), [gone.pid, stranger.pid].sort());
  await within(ourExit, 8000, 'ours killed');
  assert.ok(alive(stranger.pid!), 'a process that is not ours is not killed');
  assert.deepEqual(JSON.parse(readFileSync(pidFile(dataDir), 'utf8')).agents, []);
  stranger.kill();
});

test('sweep: a forged record (live PID, matching start time, wrong or missing program image) kills nothing', async () => {
  const dataDir = tempDir('acp-data-');
  const victim = sleeperProc();
  await waitFor(() => alive(victim.pid!));
  const now = Date.now();
  writeFileSync(pidFile(dataDir), JSON.stringify({ version: 1, agents: [
    { pid: victim.pid, startedAt: now, image: WIN ? 'C:\Windows\System32\notepad.exe' : 'notepad' },
    { pid: victim.pid, startedAt: now }, // no image: malformed, ignored
  ] }));
  const res = sweepStaleAgents(dataDir);
  assert.deepEqual(res.killed, []);
  assert.ok(alive(victim.pid!), 'the victim lives');
  assert.deepEqual(JSON.parse(readFileSync(pidFile(dataDir), 'utf8')).agents, []);
  victim.kill();
});

test('sweep: malformed records are ignored and at most 32 records are looked at', () => {
  const dataDir = tempDir('acp-data-');
  const agents: unknown[] = [null, 'x', { pid: -5, startedAt: 1, image: 'a' }, { pid: 1.5, startedAt: 1, image: 'a' }, { pid: 2 ** 40, startedAt: 1, image: 'a' }, { pid: 99, startedAt: 'now', image: 'a' }, { pid: 99, startedAt: 1, image: 7 }];
  for (let i = 0; i < 1000; i++) agents.push({ pid: 2_000_000_000 + i, startedAt: 1, image: 'a' }); // no such processes
  writeFileSync(pidFile(dataDir), JSON.stringify({ version: 1, agents }));
  const res = sweepStaleAgents(dataDir);
  assert.deepEqual(res.killed, []);
  assert.ok(res.dropped.length <= 32, `looked at ${res.dropped.length} records`);
  assert.deepEqual(JSON.parse(readFileSync(pidFile(dataDir), 'utf8')).agents, []);
});

test('sweep: a time budget that is used up leaves the rest alone (dropped, not killed)', async () => {
  const dataDir = tempDir('acp-data-');
  const ours = sleeperProc();
  await waitFor(() => alive(ours.pid!));
  writeFileSync(pidFile(dataDir), JSON.stringify({ version: 1, agents: [{ pid: ours.pid, startedAt: Date.now(), image: NODE_IMAGE }] }));
  const res = sweepStaleAgents(dataDir, { budgetMs: 0 });
  assert.deepEqual(res.killed, []);
  assert.deepEqual(res.dropped, [ours.pid]);
  assert.ok(alive(ours.pid!));
  ours.kill();
});

test('sweep: a missing or broken pid file is fine', () => {
  const dataDir = tempDir('acp-data-');
  assert.deepEqual(sweepStaleAgents(dataDir), { killed: [], dropped: [] });
  writeFileSync(pidFile(dataDir), '{not json');
  assert.deepEqual(sweepStaleAgents(dataDir), { killed: [], dropped: [] });
});

// ---------------------------------------------------------------- stderr ring and line cap

test('stderr ring: keeps the last 8 KB, redacted per whole line (also a secret that arrives in two writes)', async () => {
  registerSecret('SECRETVALUE12345');
  const script = [
    'for (let i = 0; i < 500; i++) process.stderr.write("line " + i + " " + "x".repeat(40) + "\\n");',
    'process.stderr.write("token SECRETVAL");',
    'setTimeout(() => { process.stderr.write("UE12345 end\\n"); process.stderr.write("last line without newline"); }, 80);',
  ].join('');
  const p = begin({ ...entry('ok'), args: ['-e', script] });
  const closed = new Promise<void>((r) => p.io.onClose(r));
  await within(closed, 10_000, 'close');
  const tail = p.stderrTail();
  assert.ok(tail.length <= 8192, `tail is ${tail.length} chars`);
  assert.ok(tail.length > 6000, 'the tail is full');
  assert.match(tail, /line 499 x+/);
  assert.ok(!/line 0 /.test(tail), 'old lines fall off');
  assert.ok(!tail.includes('SECRETVALUE12345') && !tail.includes('SECRETVAL'), 'the secret is masked');
  assert.match(tail, /\[redacted-secret\] end/);
  assert.match(tail, /last line without newline/);
  clearRegisteredSecrets();
});

test('line cap: a stdout line over 16 MiB is dropped with a note in the stderr tail, and the stream carries on', async () => {
  const p = begin(entry('overflow'));
  const { peer } = await handshake(p);
  const noise: string[] = [];
  const sid = (await peer.request<{ sessionId: string }>('session/new', { cwd: process.cwd(), mcpServers: [] })).sessionId;
  void noise;
  const res = await peer.request<{ stopReason: string }>('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] }, 30_000);
  assert.equal(res.stopReason, 'end_turn');
  assert.match(p.stderrTail(), /\[line over 16 MiB dropped\]/);
  await p.stop();
});

// ---------------------------------------------------------------- one-shot commands

test('runAgentCli: collects output and the exit code', async () => {
  const r = await runAgentCli(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { timeoutMs: 15_000 });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
  assert.equal(r.timedOut, false);
});

test('runAgentCli: a timeout kills the process and says so', async () => {
  const t0 = Date.now();
  const r = await runAgentCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 8000);
});

test('runAgentCli: a missing program and a relative path are results, not throws; the env option is used as given', async () => {
  const missing = await runAgentCli('definitely-not-installed-acp-agent', [], { timeoutMs: 1000 });
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /no such program/);
  const rel = await runAgentCli('./x', [], { timeoutMs: 1000 });
  assert.match(rel.stderr, /relative path/);
  const withEnv = await runAgentCli(process.execPath, ['-e', 'console.log(process.env.ONLY_THIS ?? "none", process.env.HERMES_HOME ?? "no-hh")'], { timeoutMs: 15_000, env: { ...process.env, ONLY_THIS: 'yes' } as NodeJS.ProcessEnv });
  assert.match(withEnv.stdout, /^yes /);
});

// ---------------------------------------------------------------- fix round 1

test('runAgentCli: a timeout settles even when the program started something that keeps its pipes open', async () => {
  const dir = tempDir('acp-gc-');
  const gcFile = join(dir, 'gc.pid');
  const js = `require('fs').writeFileSync('${gcFile.replace(/\\/g, '/')}',String(process.pid));setInterval(()=>{},1000)`;
  const shim = join(dir, WIN ? 'shim.cmd' : 'shim');
  writeFileSync(shim, WIN ? `@echo off\r\n"${process.execPath}" -e "${js}"\r\n` : `#!/bin/sh\n"${process.execPath}" -e "${js}"\n`);
  if (!WIN) chmodSync(shim, 0o755);
  try {
    const t0 = Date.now();
    const r = await within(runAgentCli(shim, [], { timeoutMs: 800 }), 7000, 'runAgentCli settles after the timeout');
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 6000);
  } finally {
    // the grandchild is ours: kill it by the PID it wrote
    try { const pid = Number(readFileSync(gcFile, 'utf8')); if (pid > 0) { extraPids.add(pid); process.kill(pid, 'SIGKILL'); } } catch { /* never started or gone */ }
  }
});

test('runAgentCli: an env passed by the caller goes through the same filter (LEGION_*, values holding a Legion secret)', async () => {
  const token = 'tok_cli_0123456789abcdef0123456789ab';
  registerLegionSecrets([token]);
  try {
    const r = await runAgentCli(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { timeoutMs: 15_000, env: { ...process.env, LEGION_PORT: '4747', HOLDS: `a-${token}-b`, KEEP_ME: 'k' } as NodeJS.ProcessEnv });
    const env = JSON.parse(r.stdout) as Record<string, string>;
    assert.equal(env.KEEP_ME, 'k');
    assert.ok(!('LEGION_PORT' in env) && !('HOLDS' in env));
  } finally { registerLegionSecrets([]); }
});

test('secrets fail closed: nothing starts before the core registered its secrets; a per-run token can be added later', async () => {
  forgetLegionSecrets();
  try {
    assert.throws(() => startAgentProcess(entry('ok'), { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-') }), (e) => e instanceof AgentLaunchError && e.code === 'refused' && /secrets/.test(e.message));
    const r = await runAgentCli(process.execPath, ['-e', 'console.log(1)'], { timeoutMs: 5000 });
    assert.equal(r.code, null);
    assert.match(r.stderr, /secrets/);
  } finally { registerLegionSecrets([]); }

  const runToken = 'run_tok_0123456789abcdef0123456789';
  addLegionSecret(runToken);
  try {
    const r = await runAgentCli(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { timeoutMs: 15_000, env: { ...process.env, HOLDS_RUN: runToken } as NodeJS.ProcessEnv });
    assert.ok(!('HOLDS_RUN' in (JSON.parse(r.stdout) as Record<string, string>)));
  } finally { registerLegionSecrets([]); }
});

test('a synchronous error from spawn (NUL in the environment) becomes spawn-failed, never a throw of another kind', async () => {
  assert.throws(() => startAgentProcess(entry('ok'), { cwd: tempDir('acp-cwd-'), stripSkipFlags: false, dataDir: tempDir('acp-data-'), extraEnv: { BAD: 'a\0b' } }),
    (e) => e instanceof AgentLaunchError && e.code === 'spawn-failed');
  const r = await runAgentCli(process.execPath, ['-e', 'console.log(1)'], { timeoutMs: 5000, env: { BAD: 'a\0b' } as NodeJS.ProcessEnv });
  assert.equal(r.code, null);
  assert.ok(r.stderr.length > 0);
});

test('cmdLine: letters that Windows can map to a quote or a caret (modifier letters, fullwidth forms) are refused', () => {
  for (const bad of ['a\u02BAb', 'a\u02C6b', 'a\uFF02b', 'a\uFF3Eb', 'a\u201Cb']) {
    assert.throws(() => cmdLine('C:\\x.cmd', [bad]), (e) => e instanceof AgentLaunchError && e.code === 'refused', JSON.stringify(bad));
  }
  assert.equal(cmdLine('C:\\x.cmd', ['日本語', 'Ærø']), '"C:\\x.cmd" "日本語" "Ærø"');
});

test('cmd.exe route (Windows): the child cannot resolve commands from its current folder', { skip: !WIN }, async () => {
  const dir = tempDir('acp-cmd-');
  const shim = join(dir, 'env.cmd');
  writeFileSync(shim, '@echo off\r\necho [%NoDefaultCurrentDirectoryInExePath%]\r\n');
  await withEnv({ NoDefaultCurrentDirectoryInExePath: undefined }, async () => {
    const viaCmd = await runAgentCli(shim, [], { timeoutMs: 10_000 });
    assert.equal(viaCmd.stdout.trim(), '[1]');
    const viaExe = await runAgentCli(process.execPath, ['-e', 'console.log(process.env.NoDefaultCurrentDirectoryInExePath ?? "unset")'], { timeoutMs: 10_000 });
    assert.equal(viaExe.stdout.trim(), 'unset', 'a direct launch keeps the user environment as it is');
  });
});

test('killAllAgentsSync: a used-up time budget still ends every agent', async () => {
  const dataDir = tempDir('acp-data-');
  const a = begin(entry('hang'), { dataDir });
  const b = begin(entry('hang'), { dataDir });
  await Promise.all([a, b].map(handshake));
  killAllAgentsSync(0);
  await within(Promise.all([a.exited, b.exited]), 8000, 'both exited');
  assert.ok(!alive(a.pid) && !alive(b.pid));
});
