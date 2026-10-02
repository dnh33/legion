'use strict';
// Preload (CommonJS, sandboxed). Exposes a minimal, validated bridge to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

let boot = { baseUrl: 'http://127.0.0.1:4747', token: '', admin: '', platform: process.platform };
try {
  const r = ipcRenderer.sendSync('legion:bootstrap');
  if (r && typeof r === 'object') boot = { ...boot, ...r };
} catch (_) { /* keep defaults */ }

contextBridge.exposeInMainWorld('legion', {
  baseUrl: boot.baseUrl,
  token: boot.token,
  admin: boot.admin,
  platform: boot.platform,
  // BSV policy changes go through the main process, which shows its own native confirmation. The renderer never holds the native secret.
  bsvPolicy(action) {
    return ipcRenderer.invoke('legion:bsv-policy', action);
  },
  onBsvChanged(cb) {
    if (typeof cb !== 'function') return () => undefined;
    const h = () => { try { cb(); } catch (_) { /* ignore */ } };
    ipcRenderer.on('legion:bsv-changed', h);
    return () => ipcRenderer.removeListener('legion:bsv-changed', h);
  },
  // Provider key and address changes go through the main process too: it shows the native confirmation and holds the native secret.
  providerChange(change) {
    return ipcRenderer.invoke('legion:provider-change', change);
  },
  // Project folder and member changes: main shows the native confirmation (and the folder chooser) and holds the native secret.
  projectChange(change) {
    return ipcRenderer.invoke('legion:project-change', change);
  },
  // The updater's "Restart now": main shows its own native confirmation naming what will stop, then drains and swaps.
  updateRestartNow() {
    return ipcRenderer.invoke('legion:update-restart-now');
  },
  openExternal(url) {
    return ipcRenderer.invoke('legion:open-external', String(url));
  },
});
