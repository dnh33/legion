/**
 * Source scan: nothing in src/ (tests excluded) may listen on anything but the loopback constant. Reads the files, runs nothing.
 * The one allowed `.listen(` call is inside listenLoopback in src/core/net-guard.ts, with LOOPBACK_HOST.
 * Limits: a host assembled from data at run time or a dynamic import with a computed name is not seen; that is covered by review.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(dir, rel))) {
    if (n === 'node_modules' || n === 'dist') continue;
    const r = rel ? `${rel}/${n}` : n;
    if (statSync(join(dir, r)).isDirectory()) out.push(...walk(dir, r)); else if (/\.(ts|tsx|js|mjs|cjs)$/.test(n)) out.push(r);
  }
  return out;
}
const files = ['src', 'ui/src'].flatMap((d) => walk(root, d));
const text = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, '$1');
const GUARD = 'src/core/net-guard.ts';
/**
 * The ONE file that may start a Chromium-family browser with a debugging port, and the ONE exact switch it may name (port 0, on loopback by the browser's own
 * default, reported back through DevToolsActivePort). Any other debugging switch in that file, and any debugging switch anywhere else, is still refused.
 */
export const CHROMIUM_LAUNCH_FILE = 'src/core/browser/chromium.ts';
export const CHROMIUM_ALLOWED_SWITCH = "'--remote-debugging-port=0'";

/** Returns problems found in one file's text. Exported to the mutation test below. */
export function listenProblems(file: string, src: string): string[] {
  const p: string[] = [];
  for (const m of src.matchAll(/\.listen\s*\(([^)]*)\)/g)) {
    const args = m[1]!.split(',').map((s) => s.trim());
    if (!(file === GUARD && args.length === 2 && args[1] === 'LOOPBACK_HOST')) p.push(`${file}: .listen(${m[1]}) is not the loopback constant`);
  }
  // (other files name 0.0.0.0 and '::' only to REFUSE them, e.g. providers/endpoint.ts; the rule applies to files that can bind)
  if (/\bcreateHttpServer\b|\.listen\s*\(/.test(src)) {
    if (/\b0\.0\.0\.0\b|ipv6Only/.test(src)) p.push(`${file}: names 0.0.0.0 in a file that can bind`);
    if (/['"`]::['"`]/.test(src)) p.push(`${file}: names the IPv6 any-address '::' in a file that can bind`);
  }
  if (/\.listen\s*\(\s*\{/.test(src)) p.push(`${file}: listen with an options object`);
  if (/\b(?:new\s+)?(?:net|http|https|tls|dgram|http2)\.(?:Server|createServer|createSocket)\b|\bcreateSecureServer\b|\bnew\s+(?:WebSocketServer|Server)\s*\(\s*\{[^}]*port/.test(src)) p.push(`${file}: creates a server by another route`);
  const dbgSrc = file === CHROMIUM_LAUNCH_FILE ? src.split(CHROMIUM_ALLOWED_SWITCH).join("''") : src;
  if (/--inspect|--remote-debugging|remote-debugging-port|inspector\.open|\binspector\b\s*\./.test(dbgSrc)) p.push(`${file}: opens a debugger port`);
  if (/process\.env\.(?:LEGION_HOST|HOST|BIND|BIND_ADDRESS|LISTEN)\b|--host\b|--bind\b/.test(src)) p.push(`${file}: reads a host or bind setting`);
  return p;
}

describe('loopback-only: source scan', () => {
  it('scans real files', () => { assert.ok(files.length > 50); assert.ok(files.includes('src/core/server.ts') && files.includes('src/bin/legion-core.ts') && files.includes('src/bin/legion-mcp-stdio.ts') && files.includes('src/electron/main.ts')); });
  it('the only .listen( in src is the loopback one in net-guard.ts, and nothing else binds, forwards or opens a debugger', () => {
    const problems = files.flatMap((f) => listenProblems(f, text(f)));
    assert.deepEqual(problems, []);
    assert.equal(files.filter((f) => /\.listen\s*\(/.test(text(f))).join(','), GUARD);
  });
  it('only server.ts creates the HTTP server (wallet-probe.ts imports node:http as a client only; the .listen( scan covers it), and the core, Electron and stdio entry files call listenLoopback or nothing', () => {
    assert.deepEqual(files.filter((f) => /\bcreateHttpServer\b/.test(text(f))), ['src/core/server.ts']);
    assert.deepEqual(files.filter((f) => /from ['"]node:http['"]/.test(text(f))).sort(), ['src/core/bsv/wallet-probe.ts', 'src/core/server.ts']);
    for (const f of ['src/electron/main.ts', 'src/bin/legion-mcp-stdio.ts', 'src/electron/updater-main.ts', 'src/electron/provider-ipc.ts']) assert.ok(!/createServer|\.listen\s*\(/.test(text(f)), f);
    assert.ok(/listenLoopback\(server, config\.port/.test(text('src/bin/legion-core.ts')));
    assert.ok(!/\.listen\s*\(/.test(text('src/bin/legion-core.ts')));
  });
  it('the server wires the guard before the dispatcher and the constant is 127.0.0.1', () => {
    const s = text('src/core/server.ts');
    assert.ok(s.indexOf('checkRequest(') > 0 && s.indexOf('checkRequest(') < s.indexOf('void dispatch(req, res)'));
    assert.ok(/dropNonLoopback/.test(s));
    assert.ok(/export const LOOPBACK_HOST = '127\.0\.0\.1'/.test(readFileSync(join(root, GUARD), 'utf8')));
  });
  it('mutations: each listening mistake is caught', () => {
    assert.equal(listenProblems('src/x.ts', "server.listen(4747, '0.0.0.0')").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "server.listen(4747)").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "server.listen(4747, process.env.HOST)").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "server.listen(4747, '127.0.0.1')").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "s.listen({ port: 1, host: '::' })").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "server.listen(1, LOOPBACK_HOST); const a = '0.0.0.0'").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "net.createServer()").length > 0, true);
    assert.equal(listenProblems('src/x.ts', "const a = ['--inspect=0.0.0.0:9229']").length > 0, true);
    assert.equal(listenProblems(GUARD, "server.listen(port, host)").length > 0, true);
    assert.deepEqual(listenProblems(GUARD, "server.listen(port, LOOPBACK_HOST)"), []);
  });
  it('the Chromium launcher exception is exactly one file and one switch', () => {
    const ok = "const a = ['--remote-debugging-port=0']";
    assert.deepEqual(listenProblems(CHROMIUM_LAUNCH_FILE, ok), []);
    assert.equal(listenProblems('src/x.ts', ok).length > 0, true, 'any other file is still refused');
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--remote-debugging-port=9222']").length > 0, true, 'a fixed port is refused');
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--remote-debugging-port=0', '--remote-debugging-address=0.0.0.0']").length > 0, true, 'a bind address is refused');
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--remote-debugging-pipe', '--remote-debugging-port=0']").length > 0, true);
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--inspect=0.0.0.0:9229']").length > 0, true);
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--remote-debugging-port=0']; server.listen(1)").length > 0, true, 'listening is still refused');
    assert.equal(listenProblems(CHROMIUM_LAUNCH_FILE, "const a = ['--remote-debugging-port=0', '--host', 'x']").length > 0, true);
  });
});
