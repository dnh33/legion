/**
 * Question-card screenshots. Same stack as capture.mjs / docs-shots.mjs: the REAL built UI (dist-ui) against a REAL Legion
 * core with a scripted model, fake boat.dev, fake wallet and fake Blender (see stack.mjs). One running task asks a
 * 2-question card (a recommended option and an option with a preview), and the card is driven through five states in
 * BOTH themes:
 *   - the card as it first appears, with its step tabs,
 *   - an option focused with its preview panel,
 *   - the Other free-text field open,
 *   - the review step showing all answers,
 *   - the keyboard-only focus ring (Tab sets data-kbd-nav on <html>; the card itself holds focus).
 * Usage:
 *   npm run build:ts && npm run build:ui
 *   node docs/video-v2/capture/qcard-capture.mjs          (PNGs go to $SHOTS_OUT, default docs/video-v2/qcard-shots)
 * Cleans up its processes and temp folder when it ends (also on error and on Ctrl-C).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../scripts/lib/load-playwright.mjs';
import { startStack } from './stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SHOTS_OUT || join(here, '..', 'qcard-shots');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`); return r.json; };

let stack = null;
let browser = null;
const cleanup = async () => { try { await browser?.close(); } catch { /* ignore */ } try { await stack?.stop(); } catch { /* ignore */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void cleanup().then(() => process.exit(130)); });

/** Two questions, each with a recommended option (badge, listed first) and Q1's second option carrying a preview. */
const QUESTIONS = [
  {
    question: 'How should the client treat a failed POST?',
    header: 'Retries',
    options: [
      { label: 'Never retry POST', description: 'Only GET and PUT are retried, with backoff.', recommended: true },
      {
        label: 'Retry POST once',
        description: 'One immediate retry, then surface the error.',
        preview: 'async function post(url, body) {\n  try {\n    return await fetch(url, { method: "POST", body });\n  } catch (err) {\n    // one retry, then fail loudly\n    return fetch(url, { method: "POST", body });\n  }\n}',
      },
      { label: 'Retry with a key', description: 'Send an idempotency key so a resend is safe.' },
    ],
  },
  {
    question: 'Which rollout do we start with?',
    header: 'Rollout',
    options: [
      { label: 'Behind a flag', description: 'Ship dark, enable it for the team first.', recommended: true },
      { label: 'Full rollout', description: 'Enable it for everyone at once.' },
      { label: 'Hold', description: 'Wait for the security audit.' },
    ],
  },
];

/** A page on the real UI, in the chosen theme. window.legion only mimics the Electron preload so buttons render. */
async function openPage(s, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(({ base, token, admin, thm }) => {
    try { localStorage.setItem('legion.theme', thm); localStorage.setItem('legion.ops', '0'); localStorage.setItem('legion.bsv.confirmed', '1'); } catch { /* ignore */ }
    window.legion = {
      baseUrl: base, token, admin, platform: 'win32', openExternal() {},
      bsvPolicy: async () => ({ ok: false, cancelled: true }),
      projectChange: async () => ({ ok: false, cancelled: true }),
    };
  }, { base: `http://127.0.0.1:${s.proxyPort}`, token: s.authToken, admin: s.adminSecret, thm: theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(s.pageUrl);
  await page.waitForSelector('.titlebar');
  await page.waitForSelector('.conn-online', { timeout: 15000 }).catch(() => { throw new Error('UI never went online'); });
  await sleep(700);
  return { ctx, page, errors };
}

/** Selects the running task so its thread (and the question card) is shown. */
async function selectTask(page) {
  await page.getByText('Forgemaster', { exact: true }).first().click();
  await sleep(600);
  await page.getByText('ask-qcard', { exact: false }).first().click().catch(() => undefined);
  await page.waitForSelector('.approval.question', { timeout: 12000 });
  await page.locator('.approval.question').scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(500);
}
const shot = async (page, name, { move = true } = {}) => {
  if (move) await page.mouse.move(1, 1);
  await sleep(450);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log('wrote', `${name}.png`);
};

/** Picks answers on both questions, landing on the review step.
 *  Uses the option button's own click() (not a pointer click): focusing the preview option reflows the two-column
 *  grid, so a pointer click computed before the hover can miss. The button's onClick is the same handler a real click runs. */
async function answerToReview(page) {
  await page.locator('.qopt').nth(1).evaluate((el) => el.click());   // Q1 Retries -> "Retry POST once" (single select advances)
  await sleep(500);
  await page.locator('.qopt').first().evaluate((el) => el.click());  // Q2 Rollout -> "Behind a flag" (advances to review)
  await sleep(500);
  await page.waitForSelector('.question-review', { timeout: 8000 });
}

/** Tabs until the card itself holds focus (so the ring is a genuine keyboard focus, not a pointer/mouse one). */
async function tabToCard(page) {
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press('Tab');
    const onCard = await page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a.classList?.contains('question') && a.classList.contains('approval');
    });
    if (onCard) break;
  }
  return page.evaluate(() => ({
    kbdNav: document.documentElement.hasAttribute('data-kbd-nav'),
    active: document.activeElement?.className ?? null,
    focusVisible: document.activeElement?.matches?.(':focus-visible') ?? false,
    theme: document.documentElement.getAttribute('data-theme'),
  }));
}

async function main() {
  browser = await launchChromium();
  stack = await startStack();
  const s = stack;

  // ---- seed the running task that asks the card ------------------------------------------------
  await s.script({ agent: 'forgemaster', promptIncludes: 'ask-qcard' }, [
    { say: 'Before I change the retry code I need two decisions.' },
    { tool: 'mcp__legion__ask_user_question', input: { questions: QUESTIONS } },
    { result: 'Thanks, I will proceed with your answers.', costUsd: 0.02 },
  ]);
  const t = ok(await s.call('POST', '/api/tasks', { agentId: 'forgemaster', prompt: 'ask-qcard: settle the retry policy' }), 'task');
  console.log('seeded task', t.id, t.status);
  const pending = await s.until(async () => { const q = (await s.call('GET', '/api/questions')).json; return Array.isArray(q) && q.length ? q : null; }, 20000, 'pending question');
  console.log('pending questions:', pending.length, pending[0]?.questions?.length, 'questions,', pending[0]?.questions?.[0]?.options?.length, 'options in Q1');

  for (const theme of ['dark', 'light']) {
    // (1) first appearance + (2) option focused with preview + (3) Other open
    {
      const { ctx, page, errors } = await openPage(s, theme);
      await selectTask(page);
      await shot(page, `qcard-steps-${theme}`);                        // step tabs, nothing focused
      await page.locator('.qopt').nth(1).hover();                      // focus Q1 option with a preview
      await sleep(300);
      await shot(page, `qcard-preview-${theme}`);
      await page.locator('.qopt.other').first().click();               // open the Other free-text field
      await sleep(300);
      await page.locator('.qother-input').type('Retry POST only when the body is unchanged.');
      await sleep(300);
      await shot(page, `qcard-other-${theme}`);
      console.log(theme, 'errors', errors);
      await ctx.close();
    }

    // (4) review step, all answers
    {
      const { ctx, page, errors } = await openPage(s, theme);
      await selectTask(page);
      await answerToReview(page);
      await shot(page, `qcard-review-${theme}`);
      console.log(theme, 'errors', errors);
      await ctx.close();
    }

    // (5) keyboard focus ring (data-kbd-nav)
    {
      const { ctx, page, errors } = await openPage(s, theme);
      await selectTask(page);
      const info = await tabToCard(page);
      console.log(theme, 'kbd:', JSON.stringify(info));
      await shot(page, `qcard-kbd-${theme}`, { move: false });
      console.log(theme, 'errors', errors);
      await ctx.close();
    }
  }
}

try { await main(); } catch (e) { console.error('FAILED:', e.stack || e); process.exitCode = 1; } finally { await cleanup(); }
