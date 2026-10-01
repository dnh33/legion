// Dev-only helper. Playwright is NOT a dependency of Legion; it is only needed to regenerate icons and
// screenshots. Resolution order: `import('playwright')`, then $PLAYWRIGHT_PATH (a playwright package
// directory or its index.mjs/index.js).
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    const hint = process.env.PLAYWRIGHT_PATH;
    if (hint) {
      const p = resolve(hint);
      const entry = existsSync(p) && statSync(p).isDirectory()
        ? ['index.mjs', 'index.js'].map((f) => join(p, f)).find(existsSync)
        : p;
      if (entry && existsSync(entry)) return import(pathToFileURL(entry).href);
      throw new Error(`PLAYWRIGHT_PATH is set to "${hint}" but no Playwright entry point was found there.`);
    }
    throw new Error(
      'Playwright is not installed. Run `npm i --no-save playwright && npx playwright install chromium`, ' +
      'or point PLAYWRIGHT_PATH at an existing install. (Playwright is only needed for icons and screenshots.)',
      { cause: err },
    );
  }
}

/** Launches Chromium. Set CHROMIUM_PATH to use an existing browser binary instead of Playwright's download. */
export async function launchChromium(options = {}) {
  const { chromium } = await loadPlaywright();
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), ...options });
}
