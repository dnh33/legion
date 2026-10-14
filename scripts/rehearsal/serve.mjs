// Rehearsal-only stand-in for GitHub Releases, on loopback http. Serves ONE scenario folder at a time, chosen by the text of the
// control file (re-read on every request), in the paths the updater asks for (via scripts/rehearsal/preload.mjs, which puts the
// original host first in the path):
//   /github.com/dnh33/legion/releases/latest/download/<manifest|manifest.sig|manifest-2|manifest-2.sig>   from <served>/<scenario>/ (404 when the folder has no such file)
//   /github.com/dnh33/legion/releases/download/v<ver>/<file>                   302 to objects.githubusercontent.com (a redirect hop)
//   /objects.githubusercontent.com/rehearsal/<file>                            from <served>/<scenario>/
// Every request is appended to --log as one JSON line. usage: node serve.mjs --served <dir> --control <file> --port <n> --log <file>
import { createServer } from 'node:http';
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { args, die } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { served: 'v', control: 'v', port: 'v', log: 'v' });
if (!a.served || !a.control || !a.port || !a.log) die('usage: node serve.mjs --served <dir> --control <file> --port <n> --log <file>');
const note = (o) => appendFileSync(a.log, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const REPO_PATH = '/github.com/dnh33/legion/releases';

const srv = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const scenario = existsSync(a.control) ? readFileSync(a.control, 'utf8').trim() : '';
  const send = (file) => {
    if (!scenario || !/^[A-Za-z0-9_-]+$/.test(scenario) || file !== basename(file) || !existsSync(join(a.served, scenario, file))) { note({ method: req.method, path: url.pathname, scenario, status: 404 }); res.writeHead(404); res.end('no'); return; }
    const p = join(a.served, scenario, file);
    note({ method: req.method, path: url.pathname, scenario, status: 200, bytes: statSync(p).size });
    res.writeHead(200, { 'content-length': statSync(p).size });
    createReadStream(p).pipe(res);
  };
  let m;
  if ((m = new RegExp(`^${REPO_PATH}/latest/download/(legion-update-manifest(?:-2)?\.json(?:\.sig)?)$`).exec(url.pathname))) return send(m[1]);
  if ((m = new RegExp(`^${REPO_PATH}/download/v[0-9.a-z-]+/(legion-[0-9.a-z-]+-(?:win-x64|app)\.zip)$`).exec(url.pathname))) {
    note({ method: req.method, path: url.pathname, scenario, status: 302 });
    res.writeHead(302, { location: `https://objects.githubusercontent.com/rehearsal/${m[1]}` }); res.end(); return;
  }
  if ((m = /^\/objects\.githubusercontent\.com\/rehearsal\/(legion-[0-9.a-z-]+-(?:win-x64|app)\.zip)$/.exec(url.pathname))) return send(m[1]);
  note({ method: req.method, path: url.pathname, scenario, status: 404 });
  res.writeHead(404); res.end('no');
});
srv.listen(Number(a.port), '127.0.0.1', () => note({ listening: Number(a.port) }));
