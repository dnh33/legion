/**
 * Taskbar pinning on Windows. Legion runs as `electron.exe "<install folder>"`, and sets its own AppUserModelID. Windows pins a
 * running window by finding a shortcut with the same AppUserModelID, and relaunches a pin with the window's relaunch command.
 * Setup writes its shortcuts with WScript.Shell, which cannot set an AppUserModelID, and the window had no relaunch details, so
 * "Pin to taskbar" had nothing to pin (or pinned bare electron.exe, which opens nothing), and a pinned Start-menu shortcut showed
 * up as a second taskbar button beside the running window. Pure: main.ts does the Electron calls.
 */
import { win32 } from 'node:path';

/** The id the app, its window and its shortcuts share. Changing it splits existing pins from the app: do not. */
export const APP_ID = 'dev.legion.app';

export interface AppDetails { appId: string; appIconPath: string; relaunchCommand: string; relaunchDisplayName: string }

/** What the taskbar needs to pin the window and start Legion again from the pin. */
export function windowDetails(execPath: string, appPath: string): AppDetails {
  return {
    appId: APP_ID,
    appIconPath: win32.join(appPath, 'assets', 'icon.ico'),
    relaunchCommand: `"${execPath}" "${appPath}"`,
    relaunchDisplayName: 'Legion',
  };
}

/** The part of a shortcut this module reads (Electron's shell.readShortcutLink). */
export interface ShortcutInfo { target: string; args?: string; appUserModelId?: string }

const norm = (p: string) => win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b);
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

/**
 * Whether a shortcut is one of Legion's own (it starts this install: this electron.exe with this install folder) and still lacks
 * the shared id. Only those are touched: another app's shortcut, or one for another Legion install, is left alone.
 */
export function needsId(link: ShortcutInfo, execPath: string, appPath: string): boolean {
  if (!same(link.target, execPath)) return false;
  if (!same(unquote(link.args ?? ''), appPath)) return false;
  return link.appUserModelId !== APP_ID;
}
