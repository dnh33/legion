// Pre-Latest relay for the live walk. The updater only reads /releases/latest/download/<manifest>, and a release that is not yet Latest
// cannot be reached that way, so the app's GitHub traffic (scripts/rehearsal/preload.mjs, with the REAL baked key, so signatures are still
// verified against production) is sent here. This relay answers every request from the REAL published assets:
//   /releases/latest/download/<file>   ->  https://github.com/dnh33/legion/releases/download/<tag>/<file>   (the tag being walked to)
//   /releases/download/<tag>/<file>    ->  the same real URL
// Nothing is rebuilt or re-signed. Upstream status is passed through (a 404 stays a 404: the second manifest name falls back on it).
// usage: node relay.mjs --tag v0.3.2 --port 18443 --log <file>
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { args, die } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { tag: 'v', port: 'v', log: 'v' });
if (!a.tag || !a.port || !a.log) die('usage: node relay.mjs --tag <vX.Y.Z> --port <n> --log <file>');
if (!/^v\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(a.tag)) die(`--tag must look like v0.3.2, got ${a.tag}`);
const note = (o) => appendFileSync(a.log, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const BASE = '/github.com/dnh33/legion/releases';
const FILE = /^legion-[0-9.]+-(?:win-x64|app)\.zip$|^legion-update-manifest(?:-2)?\.json(?:\.sig)?$/;

createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  let m, real;
  if ((m = new RegExp(`^${BASE}/latest/download/([^/]+)$`).exec(p)) && FILE.test(m[1])) real = `https://github.com/dnh33/legion/releases/download/${a.tag}/${m[1]}`;
  else if ((m = new RegExp(`^${BASE}/download/(v[0-9.]+)/([^/]+)$`).exec(p)) && FILE.test(m[2])) real = `https://github.com/dnh33/legion/releases/download/${m[1]}/${m[2]}`;
  if (req.method !== 'GET' || !real) { note({ path: p, status: 404, why: 'not a release file' }); res.writeHead(404); res.end('no'); return; }
  try {
    const r = await fetch(real, { signal: AbortSignal.timeout(900000) });
    note({ path: p, real, status: r.status, bytes: Number(r.headers.get('content-length') ?? 0) });
    if (!r.ok || !r.body) { res.writeHead(r.status === 404 ? 404 : 502); res.end('no'); return; }
    const len = r.headers.get('content-length');
    res.writeHead(200, len ? { 'content-length': len } : {});
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) { note({ path: p, real, status: 502, error: String(e.message) }); res.writeHead(502); res.end('no'); }
}).listen(Number(a.port), '127.0.0.1', () => note({ listening: Number(a.port), tag: a.tag }));
