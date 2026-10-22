globalThis.__ipc ??= {}; globalThis.__handle ??= {}; globalThis.__dialogs ??= []; globalThis.__killed ??= []; globalThis.__sent ??= [];
export const app = { requestSingleInstanceLock: () => true, quit() {}, on() {}, whenReady: () => new Promise(() => {}), setAppUserModelId() {} };
export const ipcMain = { on(ch, fn) { globalThis.__ipc[ch] = fn; }, handle(ch, fn) { globalThis.__handle[ch] = fn; } };
export class BrowserWindow { constructor() { this.webContents = { reload() {}, send(ch) { globalThis.__sent.push(ch); }, on() {}, setWindowOpenHandler() {}, executeJavaScript: async () => {} }; } once() {} on() {} setMenuBarVisibility() {} loadFile() {} loadURL() {} isDestroyed() { return false; } isVisible() { return true; } destroy() {} show() {} focus() {} hide() {} isMinimized() { return false; } restore() {} setOverlayIcon() {} setAppDetails() {} }
export const dialog = { showMessageBox: async (a, b) => { const o = b ?? a; globalThis.__dialogs.push(o); if (globalThis.__dialogDelay) await new Promise((r) => setTimeout(r, globalThis.__dialogDelay)); if (globalThis.__dialogThrow) throw new Error('window closed'); const q = globalThis.__dialogAnswers; return { response: q && q.length ? q.shift() : (globalThis.__dialogAnswer ?? 1) }; }, showErrorBox(t, m) { globalThis.__dialogs.push({ error: t + ' ' + m }); } };
export const Menu = { buildFromTemplate: () => ({}) }; export const nativeImage = { createEmpty: () => ({}), createFromPath: () => ({}) };
export const shell = { openExternal() {}, openPath() {} }; export class Tray { constructor() {} setToolTip() {} setContextMenu() {} on() {} }
export const safeStorage = { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => Buffer.alloc(0), decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false }) };
export class Notification { static isSupported() { return false; } constructor(o) { this.o = o; } show() {} on() {} close() {} }
export const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }) };
// Legion's confirm card is a WebContentsView in the Legion window. The emulator has no web contents to draw it in, so making the card fails and the
// question goes to the system dialog above (the card's own fallback), which records the options main passes, as before.
export const nativeTheme = { shouldUseDarkColors: false, on() {} };
export const session = { fromPartition() { throw new Error('the emulator has no web contents'); } };
export class WebContentsView { constructor() { throw new Error('the emulator has no web contents'); } }
export const powerMonitor = { on() {} };
