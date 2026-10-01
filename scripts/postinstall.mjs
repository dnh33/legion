// Downloads the Electron binary after `npm install` (Electron 44 no longer does this on its own).
// Skipped in CI or when ELECTRON_SKIP_BINARY_DOWNLOAD is set, and never fails the install: if the
// download does not work, `npm run app` will tell you, and you can re-run `npx install-electron --no`.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD || process.env.CI) {
  console.log('[legion] postinstall: skipping the Electron binary download (CI or ELECTRON_SKIP_BINARY_DOWNLOAD is set).');
  process.exit(0);
}

let installer;
try {
  installer = createRequire(import.meta.url).resolve('electron/install.js');
} catch {
  console.log('[legion] postinstall: electron is not installed; nothing to do.');
  process.exit(0);
}

const r = spawnSync(process.execPath, [installer, '--no'], { stdio: 'inherit' });
if (r.status !== 0) {
  console.warn('[legion] postinstall: the Electron binary download failed. Re-run `npx install-electron --no` when you are online.');
}
process.exit(0);
