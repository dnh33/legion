globalThis.__ipc ??= {}; globalThis.__dialogs ??= []; globalThis.__killed ??= [];
export const app = { requestSingleInstanceLock: () => true, quit() {}, on() {}, whenReady: () => new Promise(() => {}), setAppUserModelId() {} };
export const ipcMain = { on(ch, fn) { globalThis.__ipc[ch] = fn; }, handle() {} };
export class BrowserWindow { constructor() { this.webContents = { reload() {}, on() {}, setWindowOpenHandler() {}, executeJavaScript: async () => {} }; } once() {} on() {} setMenuBarVisibility() {} loadFile() {} loadURL() {} isDestroyed() { return false; } destroy() {} show() {} focus() {} hide() {} isMinimized() { return false; } restore() {} }
export const dialog = { showMessageBox: async (o) => { globalThis.__dialogs.push(o); return { response: globalThis.__dialogAnswer ?? 1 }; }, showErrorBox(t, m) { globalThis.__dialogs.push({ error: t + ' ' + m }); } };
export const Menu = { buildFromTemplate: () => ({}) }; export const nativeImage = { createEmpty: () => ({}), createFromPath: () => ({}) };
export const shell = { openExternal() {}, openPath() {} }; export class Tray { constructor() {} setToolTip() {} setContextMenu() {} on() {} }
