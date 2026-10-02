/**
 * Captures the trailer screenshots from the REAL built UI (dist-ui) talking to a REAL Legion core with fake model, fake boat.dev, fake wallet
 * and fake Blender (see stack.mjs). Usage:
 *   npm run build:ts && npm run build:ui
 *   node docs/video-v2/capture/capture.mjs [shot-name ...]      (default: all; PNGs go to docs/video-v2/shots/, or $SHOTS_OUT)
 * Cleans up its processes and temp folder when it ends (also on error and on Ctrl-C).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../scripts/lib/load-playwright.mjs';
import { startStack } from './stack.mjs';
import { runTask, seedLibrary } from './seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SHOTS_OUT || join(here, '..', 'shots');
mkdirSync(out, { recursive: true });
const want = new Set(process.argv.slice(2));
const on = (name) => want.size === 0 || want.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`); return r.json; };

let stack = null;
let browser = null;
const cleanup = async () => { try { await browser?.close(); } catch { /* ignore */ } try { await stack?.stop(); } catch { /* ignore */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void cleanup().then(() => process.exit(130)); });

/** A page on the real UI. window.legion only mimics the Electron preload so buttons render; no script here clicks anything that calls it. */
async function openPage(s, { width = 1440, height = 900, ops = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await ctx.addInitScript(({ base, token, admin, opsOn }) => {
    try { localStorage.setItem('legion.theme', 'dark'); localStorage.setItem('legion.ops', opsOn ? '1' : '0'); localStorage.setItem('legion.bsv.confirmed', '1'); } catch { /* ignore */ }
    window.legion = {
      baseUrl: base, token, admin, platform: 'win32', openExternal() {},
      bsvPolicy: async () => ({ ok: false, cancelled: true }),
      projectChange: async () => ({ ok: false, cancelled: true }),
    };
  }, { base: `http://127.0.0.1:${s.proxyPort}`, token: s.authToken, admin: s.adminSecret, opsOn: ops });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(s.pageUrl);
  await page.waitForSelector('.titlebar');
  await page.waitForSelector('.conn-online', { timeout: 15000 }).catch(async () => { console.log('conn:', await page.locator('.conn').textContent(), errors); throw new Error('UI never went online'); });
  await sleep(700);
  return { ctx, page, errors };
}
const shot = async (page, name, opts = {}) => { await page.mouse.move(1, 1); await sleep(400); await page.screenshot({ path: join(out, `${name}.png`), ...opts }); console.log('wrote', `${name}.png`); };

async function main() {
  browser = await launchChromium();
  stack = await startStack();
  const s = stack;
  const chat = async (page) => { await page.getByRole('tab', { name: 'Chat' }).click(); await sleep(300); };

  // ---------------------------------------------------------------- Library, lattice, inbox, project note
  await seedLibrary(s);

  // two earlier finished tasks so the task list is not empty
  await runTask(s, 'scribe', 'Draft the release notes', [{ say: 'Reading the merged pull requests.' }, { tool: 'Read', input: { file_path: 'CHANGELOG.md' } }, { result: 'Release notes drafted: three fixes, one new setting. Saved as RELEASE-NOTES.md.', costUsd: 0.04 }]);
  await runTask(s, 'sentinel', 'Review the login change', [{ say: 'Checking the diff.' }, { tool: 'Grep', input: { pattern: 'password', path: 'src' } }, { result: 'No plain-text passwords in the diff. One unbounded retry loop, noted.', costUsd: 0.06 }]);

  // Inbox: a clean-run note held for review (Archivist) and a web-tainted note (untrusted)
  await runTask(s, 'archivist', 'Keep the cache note', [{ tool: 'mcp__legion_kg__kg_capture', input: { kind: 'pattern', title: 'Warm the cache before a launch', fields: { when: 'A launch will bring a burst of first-time visitors.', do: 'Request the ten busiest pages once, an hour before.', because: 'The first visitor should not pay for the cold start.' }, tags: ['cache', 'release'] } }, { result: 'Proposed one note for review.', costUsd: 0.01 }]);
  await runTask(s, 'scout', 'Look up the pricing page', [
    { say: 'Fetching the public pricing page to compare.' },
    { tool: 'WebFetch', input: { url: 'https://example.invalid/pricing', prompt: 'summarise tiers' } },
    { tool: 'mcp__legion_kg__kg_capture', input: { kind: 'decision', title: 'Competitor pricing: three tiers, annual discount', fields: { chose: 'Keep our two tiers for now.', why: 'The page lists three tiers and a 20 percent annual discount.', rejected: ['Copy their third tier'], revisitIf: 'Trial sign-ups stall.' }, tags: ['pricing', 'web'] } },
    { result: 'Summary saved for review.', costUsd: 0.02 }]);

  // ---------------------------------------------------------------- Projects, rooms
  const P = ok(await s.call('POST', '/api/projects', { name: 'Harbor web app', instructions: 'We ship a small recipe-sharing web app.\nKeep changes small, write a test with every fix, and never ship on a Friday afternoon.\nAsk the Sentinel to review anything that touches login.' }), 'project');
  ok(await s.call('PUT', `/api/projects/${P.id}/members`, { members: ['forgemaster', 'scribe', 'sentinel'] }, 'native'), 'members');
  await runTask(s, 'forgemaster', 'Add a health check endpoint', [{ say: 'Adding /healthz and a test.' }, { tool: 'Read', input: { file_path: 'src/server.ts' } }, { tool: 'Grep', input: { pattern: 'listen', path: 'src' } }, { result: 'Added GET /healthz that returns 200 with the build version. One test added.', costUsd: 0.08 }], { projectId: P.id });
  await runTask(s, 'scribe', 'Write the setup guide', [{ say: 'Reading the README first.' }, { tool: 'Read', input: { file_path: 'README.md' } }, { result: 'Setup guide drafted in docs/setup.md: install, run, test.', costUsd: 0.05 }], { projectId: P.id });
  await runTask(s, 'sentinel', 'Review the sign-in change', [{ say: 'Reading the diff.' }, { tool: 'Grep', input: { pattern: 'session', path: 'src/auth' } }, { result: 'Looks right. Suggest a shorter session lifetime for shared computers.', costUsd: 0.06 }], { projectId: P.id });
  const R1 = ok(await s.call('POST', '/api/rooms', { name: 'Docs sprint', members: ['forgemaster', 'scribe', 'sentinel'], strategy: 'mention', lead: 'scribe', projectId: P.id }), 'room1');
  const R2 = ok(await s.call('POST', '/api/rooms', { name: 'Launch review', members: ['forgemaster', 'scribe', 'sentinel', 'herald'], strategy: 'mention', lead: 'herald' }), 'room2');
  await s.script({ agent: 'herald', promptIncludes: 'launch' }, [{ result: 'Draft announcement is ready. @Sentinel can you check the wording on sign-in, and @Scribe the setup steps?', costUsd: 0.02 }]);
  await s.script({ agent: 'sentinel', promptIncludes: 'Herald' }, [{ result: 'Sign-in wording is accurate. I would drop the word "instant": the email can take a minute. @Forgemaster is the status page ready?', costUsd: 0.02 }]);
  await s.script({ agent: 'scribe', promptIncludes: 'Herald' }, [{ result: 'Setup steps match the guide. I fixed two typos in the install section.', costUsd: 0.02 }]);
  await s.script({ agent: 'forgemaster', promptIncludes: 'Sentinel' }, [{ result: 'Status page is live and the health check is green. Ready when you are.', costUsd: 0.02 }]);
  ok(await s.call('POST', `/api/rooms/${R2.id}/messages`, { text: '@Herald please draft the launch announcement for Thursday.' }), 'post');
  await s.until(async () => (await s.call('GET', `/api/rooms/${R2.id}`)).json.messages.filter((m) => m.from.kind === 'bot').length >= 4, 30000, 'room replies');
  await sleep(500);
  await s.script({ agent: 'scribe', promptIncludes: 'outline' }, [{ result: 'Outline done: install, first run, tests, deploy. Over to you, @Forgemaster, for the deploy page.', costUsd: 0.02 }]);
  await s.script({ agent: 'forgemaster', promptIncludes: 'Scribe' }, [{ result: 'Deploy page added. Linked it from the guide.', costUsd: 0.02 }]);
  ok(await s.call('POST', `/api/rooms/${R1.id}/messages`, { text: '@Scribe please outline the setup guide, then hand the deploy page to Forgemaster.' }), 'post');
  await s.until(async () => (await s.call('GET', `/api/rooms/${R1.id}`)).json.messages.filter((m) => m.from.kind === 'bot').length >= 2, 30000, 'room1 replies');

  // project-scoped notes (scope agent:project.<id>)
  const pscope = `agent:project.${P.id}`;
  for (const [id, type, title, body, tags] of [
    ['p-auth', 'decision', 'Sessions last 8 hours on shared computers', '## Chose\nEight hours, then sign in again.\n\n## Why\nSeveral testers share one laptop.\n\n## Rejected\n- 30 days\n\n## Revisit if\nWe add device trust.', ['auth']],
    ['p-map', 'project', 'Where things are in Harbor', '## Where things are\n- src/server.ts: routes\n- src/auth: sign-in and sessions\n- docs/setup.md: setup guide\n\n## Open\n- Rate limit the sign-in route', ['map']],
  ]) ok(await s.call('POST', '/api/kg/nodes', { id, type, title, body, tags, scope: pscope }), id);
  ok(await s.call('POST', '/api/kg/edges', { from: 'p-auth', to: 'p-map', rel: 'part_of' }), 'pedge');
  ok(await s.call('POST', '/api/kg/edges', { from: 'p-auth', to: 'n-retry', rel: 'relates' }), 'pedge2');

  // room wake-up tasks are noise in the Recent tasks list; archive them (they stay in the rooms)
  const archiveRoomTasks = async (st) => { for (const t of (await st.call('GET', '/api/state')).json.tasks) if (/^You are /.test(t.title ?? '')) await st.call('PATCH', `/api/tasks/${t.id}`, { archived: true }); };
  await archiveRoomTasks(s);

  // ---- 3 + 2: lattice, inbox
  if (on('library-lattice') || on('library-inbox') || on('library-project-note')) {
    const { ctx, page, errors } = await openPage(s, { ops: false });
    const fit = async () => { await page.getByRole('button', { name: 'Fit to view' }).click(); await sleep(1500); };
    await page.getByRole('tab', { name: /^Library/ }).click(); await sleep(1500);
    if (on('library-lattice')) {
      await page.getByText('Retry only idempotent calls', { exact: true }).first().click();
      await sleep(1200); await fit();
      await page.mouse.move(1000, 520); await sleep(500);
      await page.screenshot({ path: join(out, 'library-lattice.png') }); console.log('wrote library-lattice.png');
    }
    if (on('library-inbox')) {
      await page.getByRole('tab', { name: /^Inbox/ }).click(); await sleep(900);
      await shot(page, 'library-inbox');
      await page.getByRole('tab', { name: 'Lattice' }).click(); await sleep(600);
    }
    if (on('library-project-note')) {
      await page.getByPlaceholder('Search the Lattice').fill('Sessions last'); await sleep(1200);
      await page.getByText('Sessions last 8 hours on shared computers').first().click(); await sleep(1200); await fit();
      await shot(page, 'library-project-note');
    }
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- 5 rooms
  if (on('rooms')) {
    const { ctx, page, errors } = await openPage(s);
    await page.getByRole('tab', { name: 'Rooms' }).click(); await sleep(1000);
    await page.getByText('Launch review', { exact: true }).first().click(); await sleep(1200);
    await shot(page, 'rooms');
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- 6 projects
  if (on('projects')) {
    const { ctx, page, errors } = await openPage(s);
    await page.locator('select').first().selectOption({ label: 'Harbor web app' }); await sleep(800);
    await page.getByText('Project page', { exact: true }).click(); await sleep(1200);
    await shot(page, 'projects');
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- 11, 12 settings (before the Blender bridge is turned on)
  if (on('update-panel') || on('settings-connections')) {
    const { ctx, page, errors } = await openPage(s);
    await page.locator('button[aria-label="Settings"]').click(); await sleep(900);
    if (on('settings-connections')) {
      await page.locator('.set-nav').getByText('Connections', { exact: true }).click(); await sleep(900);
      await shot(page, 'settings-connections');
    }
    if (on('update-panel')) {
      await page.locator('.set-nav').getByText('About', { exact: true }).click(); await sleep(1500);
      // crop to the Updates panel only (the rest of About shows temp-folder paths and the Browser card)
      const box = await page.locator('.upd').boundingBox();
      await page.mouse.move(1, 1); await sleep(300);
      await page.screenshot({ path: join(out, 'update-panel.png'), clip: { x: Math.max(0, box.x - 32), y: Math.max(0, box.y - 28), width: Math.min(1440 - box.x + 32, box.width + 64), height: box.height + 56 } });
      console.log('wrote update-panel.png');
    }
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- 10 blender get card, 9 blender chooser
  if (on('blender-get') || on('blender-chooser')) {
    ok(await s.call('POST', '/api/blender/config', { enabled: true, installPath: s.blenderPath }), 'blender on');
    if (on('blender-get')) {
      const { ctx, page, errors } = await openPage(s);
      await page.locator('button[aria-label="Settings"]').click(); await sleep(900);
      await page.locator('.set-nav').getByText('Blender', { exact: true }).click(); await sleep(1500);
      await page.locator('.bl-get').scrollIntoViewIfNeeded(); await sleep(500);
      await shot(page, 'blender-get');
      console.log('errors', errors);
      await ctx.close();
    }
    if (on('blender-chooser')) {
      const script = 'import bpy\n\n# Clear the default scene and add a simple lamp post.\nbpy.ops.object.select_all(action="SELECT")\nbpy.ops.object.delete()\nbpy.ops.mesh.primitive_cylinder_add(radius=0.05, depth=3, location=(0, 0, 1.5))\nbpy.ops.object.light_add(type="POINT", location=(0, 0, 3.1))\nbpy.context.object.data.energy = 800\n';
      const t = await runTask(s, 'sculptor', 'Build a small lamp post', [{ say: 'I will add a pole and a point light.' }, { tool: 'mcp__legion_blender__blender_exec', input: { script, purpose: 'Add a lamp post: a thin pole with a point light on top.' } }, { result: 'done' }], { wait: false });
      await s.until(async () => ((await s.call('GET', '/api/approvals')).json ?? []).length > 0, 15000, 'blender card');
      const { ctx, page, errors } = await openPage(s);
      await page.getByText('Sculptor', { exact: true }).first().click(); await sleep(600);
      await page.getByText('Build a small lamp post').first().click(); await sleep(1500);
      await shot(page, 'blender-chooser');
      console.log('errors', errors);
      await ctx.close();
      for (const a of (await s.call('GET', '/api/approvals')).json ?? []) await s.call('POST', `/api/approvals/${a.id}`, { allow: false });
      await s.until(async () => { const x = (await s.call('GET', `/api/tasks/${t.id}`)).json?.task; return x && ['done', 'error', 'cancelled'].includes(x.status); }, 15000, 'sculptor end');
    }
  }

  // ---- 1 app-approval (last in this stack: leaves a pending card)
  if (on('app-approval')) await approvalShot(s, 'app-approval');
}

/** A task thread with tool chips and a PENDING approval card from an `ask` agent. The VM is NOT started: the fake boat.dev cannot serve a desktop picture, so the panel would show a broken image. */
async function approvalShot(s, name) {
  const prompt = 'Run the tests and fix whatever fails';
  const t = await runTask(s, 'forgemaster', prompt, [
    { say: 'I will look at the test setup first, then run the suite.' },
    { tool: 'Read', input: { file_path: 'package.json' } },
    { tool: 'Grep', input: { pattern: 'describe\\(', path: 'test' } },
    { say: 'Two test files, both use the same helper. Running the suite now.' },
    { tool: 'Bash', input: { command: 'npm test -- --reporter=dot' }, as: 'b' },
    { result: 'The suite ran. All tests pass.', costUsd: 0.05 }], { wait: false });
  await s.until(async () => ((await s.call('GET', '/api/approvals')).json ?? []).length > 0, 15000, 'approval card');
  const { ctx, page, errors } = await openPage(s);
  await page.getByText('Forgemaster', { exact: true }).first().click(); await sleep(700);
  await page.getByText(prompt).first().click().catch(() => undefined); await sleep(1800);
  await shot(page, name);
  console.log('errors', errors);
  await ctx.close();
  for (const a of (await s.call('GET', '/api/approvals')).json ?? []) await s.call('POST', `/api/approvals/${a.id}`, { allow: false });
  await s.until(async () => { const x = (await s.call('GET', `/api/tasks/${t.id}`)).json?.task; return x && ['done', 'error', 'cancelled'].includes(x.status); }, 15000, 'task end');
}

/** Second stack: BSV mode on with the fake wallet. */
async function bsvStack() {
  if (!(on('bsv-status') || on('bsv-spend') || on('app-approval-13bots'))) return;
  const s = stack = await startStack();
  ok(await s.call('POST', '/api/bsv', { enabled: true }), 'bsv on');
  ok(await s.call('POST', '/api/bsv/wallet/connect', { url: s.wallet.url }, 'native'), 'wallet connect (fake wallet)');
  if (on('bsv-status') || on('bsv-spend')) {
    const { ctx, page, errors } = await openPage(s);
    await page.getByRole('button', { name: 'Open the BSV panel' }).click(); await sleep(2000);
    if (on('bsv-status')) await shot(page, 'bsv-status');
    if (on('bsv-spend')) {
      await page.locator('#bsv-h-spend').evaluate((el) => el.scrollIntoView({ block: 'start' })); await sleep(600);
      await shot(page, 'bsv-spend');
    }
    console.log('errors', errors);
    await ctx.close();
  }
  if (on('app-approval-13bots')) await approvalShot(s, 'app-approval-13bots');
  await s.stop(); stack = null;
}

async function mainAll() { await main(); await stack?.stop(); stack = null; await bsvStack(); }

try { await mainAll(); } catch (e) { console.error('FAILED:', e.stack || e); process.exitCode = 1; } finally { await cleanup(); }
