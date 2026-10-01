'use strict';
// Preload (CommonJS, sandboxed). Exposes a minimal, validated bridge to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

let boot = { baseUrl: 'http://127.0.0.1:4747', token: '', platform: process.platform };
try {
  const r = ipcRenderer.sendSync('legion:bootstrap');
  if (r && typeof r === 'object') boot = { ...boot, ...r };
} catch (_) { /* keep defaults */ }

contextBridge.exposeInMainWorld('legion', {
  baseUrl: boot.baseUrl,
  token: boot.token,
  platform: boot.platform,
  openExternal(url) {
    return ipcRenderer.invoke('legion:open-external', String(url));
  },
});
