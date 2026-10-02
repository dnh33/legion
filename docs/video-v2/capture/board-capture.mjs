/**
 * Board shots (project board, experimental switch on). Run from a tree that HAS the board (origin/claude/project-board built in a scratch
 * worktree; see shots/MANIFEST.md). The switch is the only config change: {"experimental":{"projectBoard":true}}.
 *   node docs/video-v2/capture/board-capture.mjs        (SHOTS_OUT=<dir> for the output folder)
 * Seeding: owner items through the board's HTTP routes; agent items through the real legion_board tools run by the scripted model.
 * A background poller answers Allow on the approval cards of the SEEDING runs only (it is stopped before the delete-approval shot).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../scripts/lib/load-playwright.mjs';
import { startStack } from './stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = process.env.SHOTS_OUT || join(here, '..', 'shots');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`); return r.json; };

// a core entry that is the harness one plus a field in the model log: the system prompt the engine built for each run (to read the board digest)
const h = join(repo, 'scripts', 'harness');
let fm = readFileSync(join(h, 'fake-model.mjs'), 'utf8');
fm = fm.replace('const record = { n: runs.length + 1,', "const record = { system: (typeof p.options?.systemPrompt === 'string' ? p.options.systemPrompt : (p.options?.systemPrompt?.append ?? '')), n: runs.length + 1,")
  .split('hasCanUseTool, servers }').join('hasCanUseTool, servers, system }');
writeFileSync(join(h, 'fake-model-cap.mjs'), fm);
writeFileSync(join(h, 'core-entry-cap.mjs'), readFileSync(join(h, 'core-entry.mjs'), 'utf8').replace("'./fake-model.mjs'", "'./fake-model-cap.mjs'"));

let stack = null; let browser = null; let poller = null;
const cleanup = async () => { clearInterval(poller); try { await browser?.close(); } catch { /* ignore */ } try { await stack?.stop(); } catch { /* ignore */ } };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void cleanup().then(() => process.exit(130)); });

async function openPage(s, { ops = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(({ base, token, admin, opsOn }) => {
    try { localStorage.setItem('legion.theme', 'dark'); localStorage.setItem('legion.ops', opsOn ? '1' : '0'); } catch { /* ignore */ }
    window.legion = { baseUrl: base, token, admin, platform: 'win32', openExternal() {}, bsvPolicy: async () => ({ ok: false, cancelled: true }), projectChange: async () => ({ ok: false, cancelled: true }) };
  }, { base: `http://127.0.0.1:${s.proxyPort}`, token: s.authToken, admin: s.adminSecret, opsOn: ops });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(s.pageUrl);
  await page.waitForSelector('.conn-online', { timeout: 15000 });
  await sleep(700);
  return { ctx, page, errors };
}
const shot = async (page, name, opts = {}) => { await page.mouse.move(1, 1); await sleep(500); await page.screenshot({ path: join(out, `${name}.png`), ...opts }); console.log('wrote', `${name}.png`); };

async function main() {
  browser = await launchChromium();
  const s = stack = await startStack({ configExtra: { experimental: { projectBoard: true } }, coreEntry: join(h, 'core-entry-cap.mjs') });
  const waitTask = (id) => s.until(async () => { const t = (await s.call('GET', `/api/tasks/${id}`)).json?.task; return t && ['done', 'error', 'cancelled'].includes(t.status) ? t : null; }, 25000, 'task');
  const run = async (agentId, prompt, steps, projectId) => {
    await s.script({ agent: agentId, promptIncludes: prompt }, steps);
    const r = ok(await s.call('POST', '/api/tasks', { agentId, prompt, projectId }), 'task');
    return waitTask(r.id);
  };
  poller = setInterval(async () => { try { for (const a of (await s.call('GET', '/api/approvals')).json ?? []) await s.call('POST', `/api/approvals/${a.id}`, { allow: true }); } catch { /* ignore */ } }, 150);

  console.log('board route:', (await s.call('GET', '/api/board')).status);
  const P = ok(await s.call('POST', '/api/projects', { name: 'Harbor web app', instructions: 'We ship a small recipe-sharing web app.\nKeep changes small, write a test with every fix, and never ship on a Friday afternoon.\nAsk the Sentinel to review anything that touches login.' }), 'project');
  ok(await s.call('PUT', `/api/projects/${P.id}/members`, { members: ['forgemaster', 'scribe', 'sentinel'] }, 'native'), 'members');
  const B = `/api/projects/${P.id}/board`;
  const mk = async (b) => ok(await s.call('POST', `${B}/items`, b), `item ${b.title}`);
  const ag = (id) => ({ kind: 'agent', id });

  // owner items
  await mk({ title: 'Translate the onboarding emails', description: 'Spanish and German first. They reach every new user.', status: 'backlog', priority: 'low', labels: ['i18n'] });
  await mk({ title: 'Rate limit the sign-in route', description: 'Five tries a minute per address, then a short wait.', status: 'backlog', assignee: ag('sentinel'), priority: 'high', due: '2026-10-14', labels: ['security', 'auth'] });
  await mk({ title: 'Choose the launch date', description: 'Thursday or the week after. Check the status page and the support rota first.', status: 'doing', assignee: { kind: 'owner' }, priority: 'high', labels: ['launch'] });
  const notes = await mk({ title: 'Draft the release notes', description: 'Three fixes and one new setting.', status: 'review', assignee: ag('scribe'), labels: ['docs', 'launch'] });
  const status = await mk({ title: 'Set up the status page', description: 'A public page with the current state of the app.', status: 'review', assignee: ag('forgemaster'), labels: ['infra'] });
  ok(await s.call('PATCH', `${B}/items/${status.id}`, { status: 'done' }), 'done1');
  const typo = await mk({ title: 'Fix the typo on the pricing page', status: 'review', assignee: ag('scribe'), labels: ['docs'] });
  ok(await s.call('PATCH', `${B}/items/${typo.id}`, { status: 'done' }), 'done2');

  // items the agents write themselves through the legion_board tools (these are the "Not reviewed" ones)
  const T = (name, input) => ({ tool: `mcp__legion_board__${name}`, input });
  await run('scribe', 'seed-scribe', [{ say: 'Adding what I am working on to the board.' }, T('create', { title: 'Write the setup guide', description: 'Install, first run, tests and deploy. Outline is done; the deploy page is left.', status: 'doing', priority: 'normal', labels: ['docs'] }), { result: 'Added the setup guide to the board.', costUsd: 0.02 }], P.id);
  await run('sentinel', 'seed-sentinel', [{ say: 'Putting the sign-in review on the board.' }, T('create', { title: 'Review the sign-in change', description: 'Waiting for the test data from Forgemaster before I can finish.', status: 'blocked', priority: 'high', labels: ['security'] }), { result: 'Added the review and marked it blocked.', costUsd: 0.02 }], P.id);
  await run('forgemaster', 'seed-forge-create', [{ say: 'Adding the health check to the board.' }, T('create', { title: 'Add a health check endpoint', description: 'GET /healthz returns 200 with the build version. One test.', status: 'doing', priority: 'normal', labels: ['infra'], due: '2026-10-09' }), { result: 'Added the health check item.', costUsd: 0.02 }], P.id);
  for (const r of await s.modelLog()) for (const c of r.toolCalls) console.log(r.agent, c.tool, c.decision, String(c.text).slice(0, 160).replace(/\n/g, ' '));
  // a run that calls a legion_board tool counts as tainted in this tree (the tool is not on the Legion-tool list), and a tainted run may not
  // assign; so the agents create the items and the OWNER assigns them (the board's own PATCH route, as the Assignee select does)
  {
    const v = ok(await s.call('GET', B), 'view');
    for (const [title, who] of [['Write the setup guide', 'scribe'], ['Review the sign-in change', 'sentinel'], ['Add a health check endpoint', 'forgemaster']]) {
      ok(await s.call('PATCH', `${B}/items/${v.items.find((i) => i.title === title).id}`, { assignee: ag(who) }), `assign ${title}`);
    }
  }
  const view0 = ok(await s.call('GET', B), 'view');
  const health = view0.items.find((i) => i.title === 'Add a health check endpoint');
  await run('forgemaster', 'seed-forge-finish', [
    { say: 'Finished the endpoint. Saving what I learned as a project note, then moving the item to review.' },
    { tool: 'mcp__legion_kg__kg_capture', input: { kind: 'pattern', title: 'Health checks answer fast and say the version', fields: { when: 'Adding an endpoint a status page or load balancer will poll.', do: 'Return 200 with the build version and touch no database.', because: 'A slow check looks like an outage.' }, scope: 'project', tags: ['infra'] } },
    T('update', { id: health.id, status: 'review', note: 'Done and tested. Left a project note about the pattern.' }),
    { result: 'Health check done and in review.', costUsd: 0.03 }], P.id);
  // suggestions in the Inbox
  await run('scribe', 'seed-propose-scribe', [T('propose', { title: 'Add a FAQ page to the docs', description: 'The same five questions come up in support every week.', priority: 'normal', labels: ['docs'] }), { result: 'Suggested one item.', costUsd: 0.01 }], P.id);
  await run('sentinel', 'seed-propose-sentinel', [T('propose', { title: 'Rotate the staging password', description: 'It was shared in a chat last month.', priority: 'high', labels: ['security'], suggestedAssignee: 'forgemaster' }), { result: 'Suggested one item.', costUsd: 0.01 }], P.id);

  // the digest a project run receives
  await run('scribe', 'digest-run', [{ result: 'Read the board.', costUsd: 0.01 }], P.id);
  const log = await s.modelLog();
  const sys = log.filter((r) => r.prompt.includes('digest-run')).at(-1)?.system ?? '';
  const m = /<legion-board-digest>[\s\S]*?<\/legion-board-digest>/.exec(sys);
  if (!m) throw new Error('no board digest in the run prompt');
  const dl = m[0].split('\n');
  writeFileSync(join(out, 'board-digest.txt'), dl.slice(0, 14).join('\n') + '\n');
  console.log('wrote board-digest.txt', dl.length, 'lines in the real block,', Math.min(14, dl.length), 'kept');

  // ---- board.png, board-inbox.png
  {
    const { ctx, page, errors } = await openPage(s);
    await page.locator('select').first().selectOption({ label: 'Harbor web app' }); await sleep(800);
    await page.getByText('Project page', { exact: true }).click(); await sleep(1500);
    await page.locator('.bd').scrollIntoViewIfNeeded();
    await shot(page, 'board');
    await page.getByRole('tab', { name: /^Inbox/ }).click(); await sleep(900);
    await shot(page, 'board-inbox');
    await page.getByRole('tab', { name: 'Board' }).click(); await sleep(600);
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- board-guards.png: leader set to a member, the note beside it, an item dialog with "Mark as reviewed"
  ok(await s.call('PUT', `${B}/leader`, { leader: 'sentinel' }), 'leader');
  {
    const { ctx, page, errors } = await openPage(s);
    await page.locator('select').first().selectOption({ label: 'Harbor web app' }); await sleep(800);
    await page.getByText('Project page', { exact: true }).click(); await sleep(1500);
    await shot(page, 'board-guards');
    await page.getByRole('button', { name: /^Write the setup guide/ }).first().click(); await sleep(1200);
    await shot(page, 'board-guards-dialog');
    await page.keyboard.press('Escape'); await sleep(500);
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- project-memory: the item with a linked project note, and the offer after closing an item
  {
    const { ctx, page, errors } = await openPage(s);
    await page.locator('select').first().selectOption({ label: 'Harbor web app' }); await sleep(800);
    await page.getByText('Project page', { exact: true }).click(); await sleep(1500);
    await page.getByRole('button', { name: /^Add a health check endpoint/ }).first().click(); await sleep(1200);
    await page.getByRole('heading', { name: 'Project notes' }).scrollIntoViewIfNeeded(); await sleep(500);
    await shot(page, 'project-memory-item');
    await page.keyboard.press('Escape'); await sleep(500);
    await page.locator(`select[aria-label="Move Draft the release notes to"]`).selectOption('done', { force: true }); await sleep(1200);
    await page.locator('.bd-offer').scrollIntoViewIfNeeded();
    await shot(page, 'project-memory');
    console.log('errors', errors);
    await ctx.close();
  }

  // ---- delete approval: the leader asks to delete an item; the card stays PENDING (only if the tool really gets that far)
  const victim = (ok(await s.call('GET', B), 'view')).items.find((i) => i.title === 'Translate the onboarding emails');
  await s.script({ agent: 'sentinel', promptIncludes: 'tidy-board' }, [{ say: 'The translation item has been idle and nobody owns it. I will ask to remove it.' }, T('delete', { id: victim.id }), { result: 'Asked the owner.', costUsd: 0.01 }]);
  const task = ok(await s.call('POST', '/api/tasks', { agentId: 'sentinel', prompt: 'tidy-board: clear idle items', projectId: P.id }), 'task');
  const end = await waitTask(task.id); // poller still answers the generic tool card
  const tr = (await s.modelLog()).filter((r) => r.prompt.includes('tidy-board')).at(-1);
  console.log('delete tool result:', tr?.toolCalls?.[0]?.text?.slice(0, 200), '| task', end.status);
  writeFileSync(join(out, '_delete-attempt.txt'), String(tr?.toolCalls?.[0]?.text ?? ''));
}

try { await main(); } catch (e) { console.error('FAILED:', e.stack || e); process.exitCode = 1; } finally { await cleanup(); }
