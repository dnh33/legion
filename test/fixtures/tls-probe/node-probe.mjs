// Run by test/tls-blocklist-live.test.ts under some runtime: one https.get and one fetch to the host in argv[2]; prints one JSON line.
import https from 'node:https';
const host = process.argv[2];
const code = (e) => e?.code || e?.cause?.code || e?.message || String(e);
const viaHttps = () => new Promise((res) => {
  const r = https.get({ host, path: '/', timeout: 20000 }, (s) => { s.resume(); res({ trusted: true, status: s.statusCode }); });
  r.on('error', (e) => res({ trusted: false, code: code(e) }));
  r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
});
const viaFetch = async () => { try { const r = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) }); return { trusted: true, status: r.status }; } catch (e) { return { trusted: false, code: code(e) }; } };
const out = { runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`, https: await viaHttps(), fetch: await viaFetch() };
console.log(JSON.stringify(out));
