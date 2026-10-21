// Run by test/tls-blocklist-live.test.ts as an Electron main script: net.fetch and a hidden window load (Chromium's network stack); prints one JSON line.
const { app, net, BrowserWindow } = require('electron');
const host = process.env.LEGION_PROBE_HOST;
app.whenReady().then(async () => {
  const out = { runtime: `electron ${process.versions.electron}` };
  try { const r = await net.fetch(`https://${host}/`); out.netFetch = { trusted: true, status: r.status }; } catch (e) { out.netFetch = { trusted: false, code: String(e.message) }; }
  const w = new BrowserWindow({ show: false });
  out.window = await new Promise((res) => {
    const t = setTimeout(() => res({ trusted: false, code: 'TIMEOUT' }), 25000);
    w.webContents.once('did-fail-load', (_e, c, d) => { clearTimeout(t); res({ trusted: false, code: `${c} ${d}` }); });
    w.webContents.once('did-finish-load', () => { clearTimeout(t); res({ trusted: true }); });
    w.loadURL(`https://${host}/`).catch(() => {});
  });
  console.log(JSON.stringify(out));
  app.exit(0);
});
