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
  // Settings, Web search: saving a provider key and a private-network SearXNG address. Main shows the native confirmation and holds the native secret.
  webSearchChange(change) {
    return ipcRenderer.invoke('legion:web-search-change', change);
  },
  // Project folder and member changes: main shows the native confirmation (and the folder chooser) and holds the native secret.
  projectChange(change) {
    return ipcRenderer.invoke('legion:project-change', change);
  },
  // Gate settings that loosen anything: main shows the native confirmation and holds the native secret.
  gatesChange(change) {
    return ipcRenderer.invoke('legion:gates-change', change);
  },
  // Agent editor: raising how little an agent asks. Main shows the native confirmation and holds the native secret.
  agentModeChange(change) {
    return ipcRenderer.invoke('legion:agent-mode-change', change);
  },
  // First-run "Also make my agents follow this": many agents in one native confirmation; each change is still an ordinary guarded save.
  agentModeBatch(batch) {
    return ipcRenderer.invoke('legion:agent-mode-batch', batch);
  },
  // Browser tool: choosing the browser program (Edge, Chrome) and local addresses. Main shows the native confirmation and holds the native secret.
  browserChange(change) {
    return ipcRenderer.invoke('legion:browser-change', change);
  },
  // The updater's "Restart now": main shows its own native confirmation naming what will stop, then drains and swaps.
  updateRestartNow() {
    return ipcRenderer.invoke('legion:update-restart-now');
  },
  // Settings, Connectors, GitHub: main makes the key on the first connect (restarting the core once), then starts the sign-in and opens GitHub's page.
  connectorConnect() {
    return ipcRenderer.invoke('legion:connector-connect');
  },
  // Which project page and thread the window shows (ids only), so main never notifies for what you are looking at.
  reportView(v) {
    try { ipcRenderer.send('legion:view', { pageProjectId: v && v.pageProjectId, threadTaskId: v && v.threadTaskId }); } catch (_) { /* ignore */ }
  },
  // A notification or the tray asked to open an ask: { projectId?, taskId? } (an empty one means the first waiting).
  onOpenAsk(cb) {
    if (typeof cb !== 'function') return () => undefined;
    const h = (_e, ref) => { try { cb(ref && typeof ref === 'object' ? ref : {}); } catch (_) { /* ignore */ } };
    ipcRenderer.on('legion:open-ask', h);
    return () => ipcRenderer.removeListener('legion:open-ask', h);
  },
  // Legion Core stopped by itself: what happened ({ restarted, stopped: 'limit' | 'failed' | 'starting' | null }; the restart notice is handed out once).
  coreRestartState() {
    return ipcRenderer.invoke('legion:core-restart-state');
  },
  // Main says the state changed without a reload (the core was left stopped): read it again.
  onCoreRestartChanged(cb) {
    if (typeof cb !== 'function') return () => undefined;
    const h = () => { try { cb(); } catch (_) { /* ignore */ } };
    ipcRenderer.on('legion:core-restart-changed', h);
    return () => ipcRenderer.removeListener('legion:core-restart-changed', h);
  },
  // The banner's Restart core button: the same restart as the tray.
  restartCoreNow() {
    return ipcRenderer.invoke('legion:core-restart-now');
  },
  // Settings: no argument reads "Restart Legion Core when it stops unexpectedly"; a boolean sets it.
  coreRestartOption(on) {
    return ipcRenderer.invoke('legion:core-restart-option', typeof on === 'boolean' ? on : undefined);
  },
  openLogsFolder() {
    return ipcRenderer.invoke('legion:open-logs');
  },
  openExternal(url) {
    return ipcRenderer.invoke('legion:open-external', String(url));
  },
});
