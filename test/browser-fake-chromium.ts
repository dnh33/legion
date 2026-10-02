/**
 * A stand-in for a Chromium-family browser (msedge.exe, chrome.exe), run as `node dist/test/browser-fake-chromium.js <report> <mode> <pagesFile> <chrome arguments...>`.
 * It reads --user-data-dir=..., opens the fake CDP server on a free loopback port and writes DevToolsActivePort the way the real browser does
 * ("<port>\n/devtools/browser/<guid>"). Never a real browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeCdp } from './browser-fakes.js';

const [report, mode, pagesFile, ...args] = process.argv.slice(2) as [string, string, string, ...string[]];
const dirArg = args.find((a) => a.startsWith('--user-data-dir='));
const userDataDir = dirArg ? dirArg.slice('--user-data-dir='.length) : '';
writeFileSync(report!, JSON.stringify({ argv: args, env: process.env, cwd: process.cwd(), pid: process.pid, userDataDir }));

if (mode === 'never') { setInterval(() => undefined, 1000); }
else {
  const pages = pagesFile && pagesFile !== '-' ? JSON.parse(readFileSync(pagesFile, 'utf8')) : {};
  const fake = await startFakeCdp({ pages, ...(mode === 'nojs' ? { noJs: true } : {}) }, 0);
  mkdirSync(userDataDir, { recursive: true });
  const guid = '0f3b2c1d-aaaa-bbbb-cccc-1234567890ab';
  const nl = mode === 'crlf' ? '\r\n' : '\n';
  const path = mode === 'badpath' ? '/devtools/page/xyz' : `/devtools/browser/${guid}`;
  writeFileSync(join(userDataDir, 'DevToolsActivePort'), `${fake.port}${nl}${path}${nl}`);
  if (mode === 'crash') setTimeout(() => process.exit(1), 700);
}
