/** A stand-in for embed-worker.js in tests: answers with fixed vectors and obeys a few magic texts. No model, no runtime. */
const send = (m: Record<string, unknown>): void => { process.send?.(m); };
const vec = (text: string): number[] => {
  const n = text.length % 7;
  const v = [1 + n, 2, 3];
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};
// Tests: a pin that names a file called "tamper" makes this worker report a failed integrity check, like the real one.
if ((process.argv[3] ?? '').includes('tamper')) {
  process.send?.({ fatal: 'tamper does not match its sha256.', integrity: true }, () => process.exit(1));
} else {
process.on('message', (m: unknown) => {
  const r = m as { id: number; kind: string; texts: string[] };
  if (r.texts.includes('env')) { send({ id: r.id, error: 'ENV:' + JSON.stringify({ env: Object.keys(process.env), execArgv: process.execArgv, argv: process.argv.slice(2) }) }); return; }
  if (r.texts.includes('crash')) process.exit(3);
  if (r.texts.includes('hang')) return;
  if (r.texts.includes('fail')) { send({ id: r.id, error: 'the model said no' }); return; }
  send({ id: r.id, vectors: r.texts.map((t) => [...vec(`${r.kind}:${t}`), r.kind === 'query' ? 1 : 0]), pid: process.pid, modelDir: process.argv[2] });
});
process.on('disconnect', () => process.exit(0));
send({ ready: true });
}
