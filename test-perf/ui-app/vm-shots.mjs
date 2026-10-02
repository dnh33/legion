// Screenshots for the VM fixes: a REAL core against the fake boat.dev server (free trial, key without sandbox.resume, Claude not configured).
// Usage: node test-perf/ui-app/vm-shots.mjs [outDir]   (needs `npm run build:ts && npm run build:ui` first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEnv, openPage } from './env.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { FakeBoatServer } = await import(path.join(repo, 'dist/test/fake-boat-server.js'));
const out = process.argv[2] || '/tmp/m/wt-vm-shots';
fs.mkdirSync(out, { recursive: true });

const fb = await new FakeBoatServer().start();
fb.trial = true; fb.forbidden.add('resume'); fb.providerConfigured = false; fb.providerFirst = true;

// seed home with the fake boat configured (kept under /tmp/m/wt-vm-home*; the harness copies it to the run home and deletes that on stop)
const seed = '/tmp/m/wt-vm-home-seed';
fs.rmSync(seed, { recursive: true, force: true });
fs.cpSync('/tmp/m/perf-uiapp-home', seed, { recursive: true });
const cfgPath = path.join(seed, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.boat = { apiKey: 'bk_live_SHOTKEY_000111', baseUrl: fb.baseUrl, rates: { default: 0.6, large: 2.4 }, currency: 'DKK' };
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

const env = await startEnv({ ui: path.join(repo, 'dist-ui'), repo, port: 48300, home: '/tmp/m/wt-vm-home-run', seedHome: seed });
const { browser, page, errs } = await openPage(env, { width: 1440, height: 900 });
const shot = (n) => page.screenshot({ path: path.join(out, n + '.png') });
try {
  await page.getByRole('button', { name: /^Builder/ }).first().click();
  await page.waitForTimeout(1500);
  await shot('1-computer-before-start');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForSelector('.vm-usage', { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot('2-computer-trial-fallback-usage');
  // agent editor
  await page.getByRole('button', { name: 'Edit agent' }).click();
  await page.waitForSelector('#vm-size-note');
  await shot('3-agent-editor-vm-size');
  await page.keyboard.press('Escape');
  // settings
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /boat\.dev \(VMs\)/ }).click();
  await page.waitForSelector('.set-perms');
  await page.waitForTimeout(800);
  await shot('4-settings-boat');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.waitForTimeout(1200);
  await shot('5-settings-boat-test');
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.waitForTimeout(300);
  await shot('6-settings-boat-tall');
  console.log('errors:', errs, 'fake boat creates:', fb.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes').map((r) => r.body.type));
  console.log('core stderr:', env.core().slice(0, 300));
} finally {
  await browser.close(); await env.stop(); await fb.stop();
  fs.rmSync(seed, { recursive: true, force: true });
}
process.exit(0);
