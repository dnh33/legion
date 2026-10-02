import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { chromiumArgs, chromiumCandidates, detectChromium, majorOf, parseDevToolsActivePort, versionNextTo } from '../src/core/browser/chromium.js';
import type { ChromiumIo } from '../src/core/browser/chromium.js';

/** A fake Windows file system: a set of files and a table of folder contents. Paths compare case-insensitively like Windows. */
function winIo(files: string[], dirs: Record<string, string[]> = {}): ChromiumIo {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const table = new Map(Object.entries(dirs).map(([k, v]) => [k.toLowerCase(), v]));
  return { exists: (p) => set.has(p.toLowerCase()), readDir: (p) => table.get(p.toLowerCase()) ?? [] };
}
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WINENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Me Too\\AppData\\Local' } as NodeJS.ProcessEnv;

test('E1: Windows candidates: Edge first (both Program Files folders), then Chrome (Program Files, Program Files (x86), LocalAppData), then Brave; spaces and backslashes kept', () => {
  const c = chromiumCandidates('win32', WINENV).map((x) => x.path);
  assert.equal(c[0], EDGE); assert.equal(c[1], EDGE64);
  assert.ok(c.includes(CHROME));
  assert.ok(c.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(c.includes('C:\\Users\\Me Too\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(c.some((p) => p.endsWith('\\Brave-Browser\\Application\\brave.exe')));
  assert.ok(c.every((p) => !p.includes('/')), 'no POSIX separators in Windows paths');
  assert.ok(c.indexOf(EDGE) < c.indexOf(CHROME));
  // no duplicates (the env vars and the built-in defaults name the same folders), compared case-insensitively
  assert.equal(new Set(c.map((p) => p.toLowerCase())).size, c.length);
  // env names are matched case-insensitively and a missing variable falls back to the usual folder
  const lower = chromiumCandidates('win32', { programfiles: 'D:\\Apps', 'programfiles(x86)': 'D:\\Apps86' } as NodeJS.ProcessEnv).map((x) => x.path);
  assert.equal(lower[0], 'D:\\Apps86\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.ok(chromiumCandidates('win32', {}).some((x) => x.path === EDGE));
});

test('E1: other systems list their usual places', () => {
  assert.ok(chromiumCandidates('linux', {}).some((c) => c.path === '/usr/bin/google-chrome'));
  assert.ok(chromiumCandidates('darwin', {}).some((c) => c.path === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
});

test('E1: detection takes the first that exists; the version is read from the install folder names, never by running the browser', () => {
  const dirs = { 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['99.0.1150.30', '120.0.2210.91', '120.0.2210.9', 'msedge.exe', 'SetupMetrics', 'msedge_proxy.exe'] };
  const r = detectChromium(winIo([EDGE, CHROME], dirs), 'win32', WINENV);
  assert.equal(r.found!.name, 'Microsoft Edge'); assert.equal(r.found!.path, EDGE); assert.equal(r.found!.version, '120.0.2210.91');
  assert.equal(r.found!.tooOld, undefined);
  assert.deepEqual(r.tried, [EDGE], 'it stopped at the first hit');
  // Edge missing: Chrome in Program Files
  const c = detectChromium(winIo([CHROME]), 'win32', WINENV);
  assert.equal(c.found!.name, 'Google Chrome'); assert.equal(c.found!.version, undefined, 'no version folder: accepted, version unknown');
  assert.ok(c.tried.length > 2);
});

test('E1: versions compare as numbers (99 is older than 120), and a browser older than the headless minimum is marked', () => {
  const io = winIo([], { 'C:\\X\\Application': ['9.0.0.1', '109.0.0.0', '99.1.1.1', '108.9.9.9'] });
  assert.equal(versionNextTo(io, 'C:\\X\\Application\\msedge.exe', 'win32'), '109.0.0.0');
  assert.equal(majorOf('120.0.2210.91'), 120); assert.equal(majorOf(undefined), undefined);
  const old = detectChromium(winIo([EDGE], { 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['100.0.1185.29'] }), 'win32', WINENV);
  assert.equal(old.found!.tooOld, true);
  const ok = detectChromium(winIo([EDGE], { 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application': ['109.0.1518.49'] }), 'win32', WINENV);
  assert.equal(ok.found!.tooOld, undefined);
});

test('E1: the owner\'s own path wins; if it is missing nothing else is tried (no silent substitute)', () => {
  const mine = 'D:\\Tools\\Brave Portable\\brave.exe';
  const r = detectChromium(winIo([mine, EDGE]), 'win32', WINENV, mine);
  assert.equal(r.found!.path, mine); assert.equal(r.found!.name, 'Brave');
  const gone = detectChromium(winIo([EDGE]), 'win32', WINENV, 'D:\\Gone\\chrome.exe');
  assert.equal(gone.found, null); assert.deepEqual(gone.tried, ['D:\\Gone\\chrome.exe']);
  assert.equal(detectChromium(winIo([]), 'win32', WINENV).found, null);
});

test('E2: DevToolsActivePort is parsed strictly; CRLF (a Windows file) is fine; anything that could steer the connection elsewhere is refused', () => {
  const guid = '0f3b2c1d-aaaa-bbbb-cccc-1234567890ab';
  assert.deepEqual(parseDevToolsActivePort(`51234\n/devtools/browser/${guid}\n`), { port: 51234, path: `/devtools/browser/${guid}` });
  assert.deepEqual(parseDevToolsActivePort(`51234\r\n/devtools/browser/${guid}\r\n`), { port: 51234, path: `/devtools/browser/${guid}` });
  for (const bad of ['', '51234', `0\n/devtools/browser/${guid}`, `70000\n/devtools/browser/${guid}`, `-5\n/devtools/browser/${guid}`, `abc\n/devtools/browser/${guid}`,
    '51234\n/devtools/page/xyz', '51234\n/devtools/browser/../../etc', '51234\n/devtools/browser/', `51234\nws://evil.example:80/devtools/browser/${guid}`, `51234\n//evil.example/devtools/browser/${guid}`, '51234\n/devtools/browser/a b', `51234 \n/x`]) {
    assert.equal(parseDevToolsActivePort(bad), null, JSON.stringify(bad));
  }
});

test('E3: the Chromium arguments: headless, port 0, a fresh profile folder, the hardening set, and never --no-sandbox or a bind or fixed port', () => {
  const profile = win32.join('C:\\Users\\Me Too\\AppData\\Local\\Temp\\legion-browser-abc123', 'profile');
  const a = chromiumArgs(profile);
  for (const f of ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--mute-audio']) assert.ok(a.includes(f), f);
  const joined = a.join(' ');
  assert.ok(!/--no-sandbox|--disable-web-security|--remote-debugging-address|--remote-debugging-pipe|--disable-site-isolation|--allow-running-insecure|--ignore-certificate-errors|--disable-gpu-sandbox/.test(joined));
  assert.equal(a.filter((x) => x.startsWith('--remote-debugging')).length, 1);
  assert.ok(!a.some((x) => /^--remote-debugging-port=(?!0$)/.test(x)));
  assert.equal(a[a.length - 1], 'about:blank');
  assert.ok(a.every((x) => !/\r|\n/.test(x)));
});
