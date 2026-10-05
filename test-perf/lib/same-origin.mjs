// One origin for a headless UI rig: the built UI and the core's API are served from the SAME loopback port.
//
// Why: the core's loopback guard (src/core/net-guard.ts) accepts a browser Origin only when it is the core's own
// origin, the vite dev origin, or the Electron window. A rig that serves dist-ui on a second port (the old
// `PORT + 1000` pattern) is a foreign origin to the core, so every /api call fails its CORS preflight and the
// screenshots show an app whose state, rooms, catalog and events never loaded. The fix lives in the rigs, never in
// the guard: this server plays the core's own origin, the shape the real app gets from the Electron window.
//
// The proxy tells the core the request came from the core's own origin (Origin rewritten to the core's port, Host to
// the core's host). That is exactly what the browser would send if the core itself served the UI, and what the
// guard already allows; nothing about the guard is bypassed or loosened.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp' };

/** Paths the UI sends to the core (everything else is a UI asset). */
export const isCorePath = (p) => p.startsWith('/api/') || p === '/api' || p === '/health' || p.startsWith('/mcp');

/** Request headers for the core: same request, presented as coming from the core's own origin. */
export function coreHeaders(req, corePort) {
  const h = { ...req.headers, host: `127.0.0.1:${corePort}` };
  if (h.origin !== undefined) h.origin = `http://127.0.0.1:${corePort}`;
  return h;
}

/** Serve one file of a built UI directory; 404 outside it. */
export function serveStatic(uiDir, req, res) {
  const root = path.resolve(uiDir);
  let p = decodeURIComponent((req.url || '/').split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!(f === root || f.startsWith(root + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
}

/** Forward one request to the core, streaming both ways (SSE included). `onResponse(req, res)` runs once headers are sent. */
export function proxyToCore(corePort, req, res, onResponse) {
  const pr = http.request({ host: '127.0.0.1', port: corePort, path: req.url, method: req.method, headers: coreHeaders(req, corePort) }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    onResponse?.(req, res);
    ur.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) res.statusCode = 502; res.end(); });
  req.pipe(pr);
}

/**
 * Start the single-origin server. `extra(req, res)` may answer rig-only paths first (return true when it did).
 * Resolves to { server, origin, uiUrl, close() }. Pass `origin` as window.legion.baseUrl and open `uiUrl`.
 */
export async function serveSameOrigin({ uiDir, corePort, port = 0, extra, onProxied }) {
  const server = http.createServer((req, res) => {
    if (extra && extra(req, res)) return;
    const p = (req.url || '/').split('?')[0];
    if (isCorePath(p)) { proxyToCore(corePort, req, res, onProxied); return; }
    serveStatic(uiDir, req, res);
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, uiUrl: `${origin}/index.html`, close: () => { server.closeAllConnections?.(); server.close(); } };
}
