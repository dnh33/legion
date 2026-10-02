/**
 * A stand-in for the lightpanda executable, run as `node dist/test/browser-fake-lightpanda.js <report> <mode> <pagesFile> serve --host H --port P ...`
 * (the same test seam the Blender tests use: a node script instead of the real program). Never the real Lightpanda.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { startFakeCdp } from './browser-fakes.js';

const [report, mode, pagesFile, ...args] = process.argv.slice(2) as [string, string, string, ...string[]];
writeFileSync(report!, JSON.stringify({ argv: args, env: process.env, cwd: process.cwd(), pid: process.pid }));
const i = args.indexOf('--port');
const port = i >= 0 ? Number(args[i + 1]) : 0;

if (mode === 'reject') { process.stderr.write('error: unrecognized option --block-private-networks\nusage: lightpanda serve [options]\n'); process.exit(2); }
if (mode === 'never') { setInterval(() => undefined, 1000); }
else {
  const pages = pagesFile && pagesFile !== '-' ? JSON.parse(readFileSync(pagesFile, 'utf8')) : {};
  await startFakeCdp({ pages }, port);
  if (mode === 'crash') setTimeout(() => process.exit(1), 700);
  // otherwise: runs until killed
}
