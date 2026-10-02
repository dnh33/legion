/**
 * A FAKE BSV wallet for the harness: plain Node http on a random loopback port. It answers only the four read-only probe methods
 * Legion's own probe sends (getVersion, getNetwork, isAuthenticated, getHeight). Any other method is answered 404 and recorded
 * under `offAllowlist`, so a scenario can assert nothing else ever reached the wire.
 *
 * Safety: it refuses to bind the forbidden port (the one a real wallet on the owner's PC uses) and refuses any non-loopback peer.
 * PENDING (built in other branches): spend methods (createAction / signAction / abortAction). See docs/TESTING-BSV.md for where to add them.
 */
import { createServer } from 'node:http';

/** The port of the owner's real wallet. Nothing in this harness may bind, call or probe it. */
export const FORBIDDEN_PORT = 3321;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const PROBE_METHODS = ['getVersion', 'getNetwork', 'isAuthenticated', 'getHeight'];

/** Throws unless `target` (a URL string or a port number) is a loopback address on an allowed port. */
export function assertSafeWalletTarget(target) {
  if (typeof target === 'number') {
    if (target === FORBIDDEN_PORT) throw new Error('harness refuses the real wallet port');
    return;
  }
  const u = new URL(String(target));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`harness refuses a non-loopback wallet host: ${u.hostname}`);
  if (Number(u.port) === FORBIDDEN_PORT) throw new Error('harness refuses the real wallet port');
}

/** @param {{network?: string, authenticated?: boolean, version?: string, height?: number, port?: number}} [opts] */
export async function startFakeWallet(opts = {}) {
  const state = { network: opts.network ?? 'testnet', authenticated: opts.authenticated ?? true, version: opts.version ?? '1.2.3', height: opts.height ?? 1234567 };
  const seen = [];
  const offAllowlist = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const peer = req.socket.remoteAddress ?? '';
      const method = (req.url ?? '/').slice(1);
      seen.push({ httpMethod: req.method, method, body: Buffer.concat(chunks).toString('utf8'), origin: req.headers.origin ?? null });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!LOOPBACK.has(peer)) { res.destroy(); return; }
      if (!PROBE_METHODS.includes(method)) { offAllowlist.push(method); return send(404, { error: 'not implemented by the harness fake wallet' }); }
      if (method === 'getVersion') return send(200, { version: state.version });
      if (method === 'getNetwork') return send(200, { network: state.network });
      if (method === 'isAuthenticated') return send(200, { authenticated: state.authenticated });
      return send(200, { height: state.height });
    });
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(opts.port ?? 0, '127.0.0.1', r); });
  const port = server.address().port;
  if (port === FORBIDDEN_PORT) { server.close(); throw new Error('harness refuses the real wallet port'); }
  assertSafeWalletTarget(port);
  return {
    url: `http://127.0.0.1:${port}`, port, state, seen, offAllowlist,
    setState(patch) { Object.assign(state, patch); },
    async stop() { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); },
  };
}
