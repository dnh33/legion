#!/usr/bin/env node
/**
 * Legion test harness CLI (zero dependencies). See docs/TESTING.md.
 *   start [--no-pointer]               launch an isolated real core wired to fakes; prints one JSON handle line
 *   status [--handle F]                JSON status of the running stack
 *   call METHOD PATH [JSON] [--auth A] [--handle F]    one request to the core; A = admin (default) | token | none | admin-only | native
 *   stop [--handle F]                  stop the stack (recorded pids only) and delete its temp folder
 *   scenarios [name ...] [--list] [--verbose] [--handle F]   run named end-to-end scenarios (a fresh stack per scenario unless --handle is given); JSON PASS/FAIL, exit 1 on any FAIL
 * Requires `npm run build:ts` first.
 */
import { client, readHandle, startHarness, stopHarness, writePointer } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const fail = (msg, code = 2) => { process.stderr.write(JSON.stringify({ error: msg }) + '\n'); process.exit(code); };

const handleArg = flag('--handle');
const authArg = flag('--auth');
const noPointer = bool('--no-pointer');
const listOnly = bool('--list');
const verbose = bool('--verbose');
const cmd = argv.shift();

try {
  if (cmd === 'start') {
    const h = await startHarness();
    if (!noPointer) writePointer(h);
    print({ baseUrl: h.baseUrl, handleFile: h.handleFile, supervisorPid: h.supervisorPid, corePid: h.corePid, harnessDir: h.harnessDir, fakes: h.fakes });
  } else if (cmd === 'status') {
    const h = readHandle(handleArg);
    print(await client(h).status());
  } else if (cmd === 'call') {
    const [method, path, json] = argv;
    if (!method || !path) fail('usage: call METHOD PATH [JSON] [--auth admin|token|none|admin-only|native]');
    let body; if (json !== undefined) { try { body = JSON.parse(json); } catch { fail('the JSON body does not parse'); } }
    const r = await client(readHandle(handleArg)).call(method.toUpperCase(), path, body, authArg || 'admin');
    print(r);
  } else if (cmd === 'stop') {
    const h = readHandle(handleArg);
    const left = await stopHarness(h);
    print({ stopped: left.pidsAlive.length === 0 && !left.dirLeft, ...left });
    if (left.pidsAlive.length || left.dirLeft) process.exit(1);
  } else if (cmd === 'scenarios') {
    const { SCENARIOS, runScenarios } = await import('./scenarios.mjs');
    if (listOnly) { print(SCENARIOS.map((s) => ({ name: s.name, proves: s.proves, doesNotProve: s.doesNotProve }))); process.exit(0); }
    const names = argv.length ? argv : SCENARIOS.map((s) => s.name);
    for (const n of names) if (!SCENARIOS.some((s) => s.name === n)) fail(`unknown scenario "${n}" (try --list)`);
    const out = await runScenarios(names, handleArg ? readHandle(handleArg) : null, { verbose });
    print(out);
    process.exit(out.ok ? 0 : 1);
  } else {
    fail('usage: legion-harness.mjs start | status | call METHOD PATH [JSON] | stop | scenarios [name ...] [--list]');
  }
} catch (e) {
  fail(String(e?.message ?? e), 2);
}
