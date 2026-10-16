/**
 * Copies the "Updating Legion" window's files out of the install, into <install>/.update/run/window, before the app quits. The window runs from
 * there for the whole update, so no swap (which renames dist, assets and the rest) can pull files from under it. The folder keeps the shape of dist
 * so the compiled imports resolve unchanged, and gets its own package file so the compiled ES modules load.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What the window needs, relative to the install. Each is copied to the same relative place inside the window folder, except the page and the icon, which sit at its top. */
export const WINDOW_SOURCES: ReadonlyArray<{ from: string; to: string }> = Object.freeze([
  { from: 'dist/src/electron/update-window-main.js', to: 'dist/src/electron/update-window-main.js' },
  { from: 'dist/src/core/updater/journey.js', to: 'dist/src/core/updater/journey.js' },
  { from: 'dist/src/core/updater/update-window-logic.js', to: 'dist/src/core/updater/update-window-logic.js' },
  { from: 'assets/update-window.html', to: 'update-window.html' },
  { from: 'assets/icon.png', to: 'icon.png' },
]);

export const windowDir = (installDir: string): string => join(installDir, '.update', 'run', 'window');

export function copyWindowFiles(installDir: string): { ok: true } | { ok: false; missing: string[] } {
  const missing = WINDOW_SOURCES.filter((f) => !existsSync(join(installDir, f.from))).map((f) => f.from);
  if (missing.length) return { ok: false, missing };
  const dir = windowDir(installDir);
  try {
    // the package file goes last: without it the window refuses to start, so a copy that died half way never looks complete
    rmSync(join(dir, 'package.json'), { force: true });
    for (const f of WINDOW_SOURCES) { mkdirSync(dirname(join(dir, f.to)), { recursive: true }); cpSync(join(installDir, f.from), join(dir, f.to)); }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'legion-update-window', version: '0.0.0', private: true, type: 'module', main: 'dist/src/electron/update-window-main.js' }));
    return { ok: true };
  } catch (e) {
    return { ok: false, missing: [e instanceof Error ? e.message : String(e)] };
  }
}
