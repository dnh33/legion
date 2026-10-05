// Serves the built UI and proxies every /api call to the harness core with the admin secret,
// so the browser window sees exactly what the Electron window sees. SSE is passed straight through
// with the bearer token (it is a client route), everything else goes through the control server.
// Usage: node serve.mjs <handleFile> [port]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const handleFile = process.argv[2];
const PORT = Number(process.argv[3] || 5173);
const handle = JSON.parse(readFileSync(handleFile, 'utf8'));
const DIST = 'D:/bots/legion/dist-ui';
const authToken = JSON.parse(readFileSync(join(handle.home, 'config.json'), 'utf8')).authToken;
const corePort = Number(new URL(handle.baseUrl).port);
/** The stack's LEGION_HOME. No screenshot may carry this temp path, so every JSON body is rewritten. */
const home = handle.harnessDir;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); try { res(raw ? JSON.parse(raw) : undefined); } catch { res(undefined); } }); });

/** One admin-authenticated call through the harness control server. */
async function core(method, path, body) {
  const r = await fetch(handle.control.url + '/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.control.token}` },
    body: JSON.stringify({ method, path, body, auth: 'admin' }),
  });
  const out = await r.json();
  let text = out.json === undefined ? (out.text ?? '') : JSON.stringify(out.json);
  // The harness core is wired to a scripted model and labels it "(harness)". The real app labels it
  // with the model name. Rewrite the label so no screenshot leaks the test rig.
  // The stack's LEGION_HOME is a temp folder. `text` is already JSON-encoded, so Windows separators
  // appear doubled: match the encoded form, longest first, and swap in a plausible workspace.
  if (home) {
    const enc = (s) => s.replace(/\\/g, '\\\\');
    for (const [from, to] of [[home + '\\home', 'D:\\Legion'], [home + '/home', 'D:/Legion'], [home, 'D:\\Legion\\.legion']]) {
      for (const key of [...new Set([from, enc(from)])]) if (text.includes(key)) text = text.split(key).join(enc(to));
    }
  }
  if (path === '/api/catalog' && out.json) {
    const c = out.json;
    for (const m of c.models ?? []) if (/\(harness\)/.test(m.displayName ?? '')) m.displayName = m.displayName.replace(/\s*\(harness\)/, '');
    text = JSON.stringify(c);
  }
  return { status: out.status, text, type: out.json === undefined ? 'text/plain' : 'application/json' };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');

  // The event stream must stay a live stream, so it bypasses the control server.
  if (url.pathname === '/api/events') {
    const up = fetch(`${handle.baseUrl}/api/events?token=${authToken}`, { headers: { Accept: 'text/event-stream' } });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const r = await up;
    for await (const chunk of r.body) res.write(Buffer.from(chunk));
    return res.end();
  }

  // The harness's fake boat.dev cannot capture a desktop, so it answers the live-view route with the
  // same 409 the real core answers when a capture is unavailable. The UI then draws its own fallback
  // instead of a broken image. No fake desktop image is invented.
  const shot = url.pathname.match(/^\/api\/vms\/[^/]+\/screenshot$/);
  if (shot) {
    res.writeHead(409, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Live view is not available for this VM' }));
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readBody(req);
      const out = await core(req.method, url.pathname + url.search, body);
      res.writeHead(out.status, { 'content-type': out.type });
      return res.end(out.text);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }

  // static
  let p = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
  let file = resolve(DIST, p);
  if (!file.startsWith(resolve(DIST)) || !existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`legion shots rig on http://127.0.0.1:${PORT} -> core ${corePort}`));