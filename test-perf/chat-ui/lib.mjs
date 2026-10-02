// Shared bits for the chat-ui Playwright checks.
import assert from 'node:assert/strict';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';

process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
export { assert };

export async function openPage(env, { width = 1280, height = 860, scheme = 'dark', touch = false, init } = {}) {
  const browser = await launchChromium({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'], hasTouch: touch, isMobile: false });
  await ctx.addInitScript(({ base, token, admin }) => { window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {} }; }, { base: env.base, token: env.token, admin: env.admin });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (404|409|500)/.test(m.text())) errs.push('console: ' + m.text()); }); // 404 = /api/bsv (the harness has no BSV module); 409/500 are the scripted failures in queue.mjs
  await page.goto(env.uiUrl);
  await page.waitForSelector('.titlebar');
  await page.waitForSelector('textarea[aria-label="Message"]');
  await page.waitForTimeout(600);
  return { browser, ctx, page, errs };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(40); }
  throw new Error(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`);
}

export function runner() {
  const res = []; let failed = 0;
  return {
    async check(name, fn) { try { await fn(); res.push('ok   ' + name); } catch (e) { failed++; res.push('FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); } },
    report() { console.log(res.join('\n')); console.log(failed ? `${failed} FAILED` : 'all passed', `(${res.length} checks)`); return failed; },
  };
}

export const composer = (page) => page.locator('textarea[aria-label="Message"]');
export async function typeEnter(page, text, key = 'Enter') {
  const ta = composer(page); await ta.click(); await ta.fill(text); await ta.press(key);
}
export const queueTexts = (page) => page.locator('[data-testid="queue-item"] .q-text').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
export const queueCount = (page) => page.locator('[data-testid="queue-item"]').count();
export const userBubbles = (page) => page.locator('.thread .msg.user .bubble').allInnerTexts();
