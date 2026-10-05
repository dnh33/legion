// Real core (token harness) + static dist-ui server for the Lattice measurements.
//   ROOT=<repo or build tree> node test-perf/lattice/core.mjs   (prints one JSON line, then stays up)
// ROOT picks BOTH the core (ROOT/dist) and the UI (ROOT/dist-ui), so a baseline tree measures old core + old UI together.
// EXTRA_NODES / EXTRA_EDGES add synthetic notes. GET <emit>/?changed=a,b emits a kg.updated with that changed[] list.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
import { serveSameOrigin } from '../lib/same-origin.mjs';
const ROOT = path.resolve(process.env.ROOT || process.cwd());
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { mount } = await imp('dist/test/token-harness.js');
const { TOKEN, TEST_ADMIN } = await imp('dist/test/helpers-c.js');
const extra = Number(process.env.EXTRA_NODES || 0), extraEdges = Number(process.env.EXTRA_EDGES || 0);
const m = await mount(() => undefined, { seeded: false });
const H = { Authorization: `Bearer ${TOKEN}`, 'X-Legion-Admin': TEST_ADMIN, 'Content-Type': 'application/json' };
const api = async (method, p, body) => { const r = await fetch(m.srv.base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : undefined }; };
await api('POST', '/api/bsv', { enabled: true });
await api('POST', '/api/kg/nodes', { title: 'My note', type: 'note', body: 'hello', tags: ['x'], scope: 'shared' });
if (extra) {
  const ids = [];
  for (let i = 0; i < extra; i++) { const x = await api('POST', '/api/kg/nodes', { title: `Synthetic ${i} ${['alpha', 'beta', 'gamma', 'delta'][i % 4]}`, type: ['note', 'concept', 'decision', 'lesson'][i % 4], body: `body ${i} lorem alpha beta`, tags: ['syn', 't' + (i % 9)], scope: 'shared' }); ids.push(x.json.node.id); }
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const rels = ['relates_to', 'depends_on', 'supports', 'part_of']; let made = 0;
  for (let k = 0; k < extraEdges * 2 && made < extraEdges; k++) { const a = ids[Math.floor(rnd() * ids.length)], b = ids[Math.floor(rnd() * ids.length)]; if (a === b) continue; const x = await api('POST', '/api/kg/edges', { from: a, to: b, rel: rels[Math.floor(rnd() * rels.length)] }); if (x.status < 300) made++; }
}
const stats = (await api('GET', '/api/kg/stats')).json;
const root = path.join(ROOT, 'dist-ui');
// UI and API on ONE origin (../lib/same-origin.mjs): the core's guard refuses a UI served from a second port, so `core` below
// is that origin (it proxies /api to the real core); `coreDirect` is the core itself, for node-side calls that want it.
const ui = await serveSameOrigin({ uiDir: root, corePort: Number(new URL(m.srv.base).port) });
const em = http.createServer((req, res) => { const ch = new URL(req.url, 'http://x').searchParams.get('changed'); m.bus.emit({ type: 'kg.updated', nodeCount: stats?.nodes ?? 0, edgeCount: stats?.edges ?? 0, changed: ch ? ch.split(',') : [] }); res.end('ok'); });
await new Promise((r) => em.listen(0, '127.0.0.1', r));
console.log(JSON.stringify({ emit: `http://127.0.0.1:${em.address().port}`, core: ui.origin, coreDirect: m.srv.base, ui: ui.origin, token: TOKEN, admin: TEST_ADMIN, stats }));
process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); // the parent closing its end (or dying) stops this core
setInterval(() => {}, 1e6);
