// Dev-only mock of the Legion core HTTP API for visual checks.  node ui/dev/mock-server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] || 47811);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-ui');
const now = () => new Date().toISOString();
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const vm = (o = {}) => ({ agentId: 'builder', sandboxId: 'sbx_1', state: 'running', size: 'large', lastUsedAt: ago(1), createdAt: ago(60), ...o });
const agent = (id, name, emoji, description, model, approval, vmOn, size = 'default') => ({
  id, name, emoji, description, systemPrompt: '', model, approval, mcpServers: ['*'], createdAt: ago(9999), updatedAt: ago(9999),
  vm: { enabled: vmOn, size, idleStopMinutes: 15 },
});
const LONG_LINE = 'const result = await client.request({ method: "POST", url: "https://api.example.com/v2/organizations/acme/projects/legion/deployments", headers: { Authorization: `Bearer ${process.env.DEPLOY_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main", environment: "production", force: false }) });';

/**
 * Scenario flags ride in the page token: ?base=...&token=first.vm-running.long  (dot separated)
 *   first        first run: no tasks, no boat key, doctor failing
 *   empty        agents but no tasks
 *   long         very long agent names / descriptions / task titles
 *   vm-none | vm-starting | vm-running | vm-archived | vm-error | vm-disabled   state of Zealot's VM (default vm-none)
 *   noboat       boat.dev key not configured
 *   doctor-pass  every Doctor check passes
 *   offline      /api/events refuses (shows Offline, retrying)
 *   down         every /api call fails (core unreachable)
 *   apierr       starting a VM / sending a task fails with a long error
 *   approval     pending approvals (Zealot 1, Builder 2)
 *   sel-err | sel-code   open Zealot on the failed run / the long-code run
 */
function makeDb(flags) {
  const f = (n) => flags.has(n);
  const long = f('long');
  const db = {
    agents: [
      agent('zealot', long ? 'Zealot the Incorruptible Lead Orchestrator of Many Legions' : 'Zealot', '✠', long ? 'General-purpose lead agent that can delegate to every other agent, read the whole repository and summarise it afterwards' : 'Lead agent of the Legion: takes any request, delegates to the order.', 'auto', 'auto-edits', !f('vm-disabled')),
      agent('builder', long ? 'Builder of Extraordinarily Long Named Things' : 'Builder', '⌘', 'Coding and building; prefers its VM for risky work.', 'auto', 'auto-edits', true, 'large'),
      agent('scout', 'Scout', '◎', 'Research, reading and summarising.', 'sonnet', 'ask', false),
    ],
    tasks: [], vms: [], approvals: [], messages: {},
    boat: !(f('noboat') || f('first')),
    settings: {
      claude: { auth: 'claude-login', apiKeySet: false, executablePath: undefined, inheritClaudeCodeSettings: true, maxTurns: 40 },
      boat: { apiKeySet: !(f('noboat') || f('first')), apiKeyHint: !(f('noboat') || f('first')) ? '\u2026a3f9' : undefined, baseUrl: 'https://boat.dev/api/v1' },
      mcpServers: f('mcp') ? { github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '\u2022\u2022\u2022\u2022ghp4', LOG_LEVEL: 'info' } }, docs: { type: 'http', url: 'https://mcp.example.com/docs', headers: { Authorization: '\u2022\u2022\u2022\u20221234' } } } : {},
      port: PORT, configPath: 'C:\\Users\\you\\.legion\\config.json', dataDir: 'C:\\Users\\you\\.legion',
    },
  };
  if (f('first') || f('empty')) return db;
  const T = long
    ? 'Audit the complete authentication and authorization flow across every service in the monorepo and then refactor the token refresh logic so that it can never race'
    : 'Audit the auth flow and refactor the token refresh';
  db.tasks = [
    { id: 't1', agentId: 'zealot', title: T, status: 'done', source: 'ui', requestedModel: 'auto', model: 'opus', escalated: true, costUsd: 0.184, turns: 9, createdAt: ago(40), updatedAt: ago(32) },
    { id: 't2', agentId: 'zealot', title: 'Summarise yesterday’s logs', status: 'done', source: 'ui', requestedModel: 'auto', model: 'sonnet', costUsd: 0.021, turns: 3, createdAt: ago(300), updatedAt: ago(290) },
    { id: 't3', agentId: 'builder', title: 'Build the landing page in Vite', status: 'running', source: 'ui', requestedModel: 'auto', model: 'sonnet', costUsd: 0.412, turns: 14, createdAt: ago(12), updatedAt: ago(0) },
    { id: 't4', agentId: 'zealot', title: 'Deploy to production', status: 'error', source: 'ui', requestedModel: 'auto', model: 'sonnet', costUsd: 0.05, turns: 4, error: 'Claude Code process exited with code 1: 529 overloaded_error — the API is temporarily overloaded. Retry in a few moments, or switch this agent to Sonnet.', createdAt: ago(100), updatedAt: ago(f('sel-err') ? 1 : 90) },
    { id: 't5', agentId: 'zealot', title: 'Show me the deploy client code', status: 'done', source: 'ui', requestedModel: 'sonnet', model: 'sonnet', costUsd: 0.03, turns: 2, createdAt: ago(200), updatedAt: ago(f('sel-code') ? 1 : 180) },
  ];
  db.tasks.push({ id: 't6', agentId: 'zealot', title: '/opus Check https://example.com/a/really/long/unbroken/url/that/never/ever/stops/going/on/and/on/and/on/forever', status: 'cancelled', source: 'ui', requestedModel: 'opus', createdAt: ago(500), updatedAt: ago(480) });
  const z = { 'vm-starting': 'provisioning', 'vm-running': 'running', 'vm-archived': 'archived', 'vm-error': 'error' }[[...flags].find((x) => x.startsWith('vm-') && x !== 'vm-none' && x !== 'vm-disabled')];
  if (z) db.vms.push(vm({ agentId: 'zealot', state: z, size: 'default', error: z === 'error' ? 'boat.dev returned 502 while provisioning the sandbox. Try again in a minute.' : undefined }));
  db.vms.push(vm({ agentId: 'builder' }));
  if (f('bridge')) {
    db.tasks.push({ id: 't7', agentId: 'builder', title: 'Zealot: Migrate the auth module to the new session API and keep the tests green', status: f('bridge-run') ? 'running' : 'done', source: 'agent', fromAgentId: 'zealot', parentTaskId: 't1', requestedModel: 'auto', model: 'sonnet', costUsd: 0.09, turns: 6, createdAt: ago(20), updatedAt: ago(f('bridge-run') ? 0 : 15) });
  }
  db.messages = {
    t1: [
      { id: 'm1', taskId: 't1', role: 'user', text: 'Audit the auth flow and refactor the token refresh so it cannot race.', at: ago(40) },
      { id: 'm2', taskId: 't1', role: 'tool', toolName: 'Grep', text: JSON.stringify({ pattern: 'refreshToken', path: 'src/' }), at: ago(39) },
      { id: 'm3', taskId: 't1', role: 'tool', toolName: 'Read', text: JSON.stringify({ file_path: 'src/auth/session.ts' }), at: ago(39) },
      { id: 'm4', taskId: 't1', role: 'tool', toolName: 'mcp__legion__vm_exec', text: JSON.stringify({ command: 'npm test -- auth', timeoutSeconds: 120 }), at: ago(38) },
      { id: 'm5', taskId: 't1', role: 'assistant', at: ago(33), text: "I found the **race condition**: two callers can hit `refresh()` at once and both burn the refresh token.\n\nThe fix is to share one in-flight promise:\n\n```ts\nlet inflight: Promise<Token> | null = null;\nexport function refresh() {\n  return (inflight ??= doRefresh().finally(() => { inflight = null; }));\n}\n```\n\nWhat changed:\n- `session.ts` now dedupes concurrent refreshes\n- added a regression test in `auth.test.ts`\n- tokens are rotated *after* the response is stored\n\nDocs: [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) has the background." },
      { id: 'm6', taskId: 't1', role: 'user', text: 'Nice. Can you also add a test for the error path?', at: ago(33) },
      { id: 'm7', taskId: 't1', role: 'assistant', at: ago(32), text: 'Done. The new test asserts that a failed refresh clears `inflight`, so the next caller retries cleanly.' },
    ],
    t2: [],
    t3: [
      { id: 'n1', taskId: 't3', role: 'user', text: 'Build the landing page in Vite, dark theme, one hero + pricing.', at: ago(12) },
      { id: 'n2', taskId: 't3', role: 'tool', toolName: 'Bash', text: JSON.stringify({ command: 'npm create vite@latest landing -- --template react-ts' }), at: ago(11) },
      { id: 'n3', taskId: 't3', role: 'assistant', at: ago(10), text: 'Vite scaffolded `landing/` from the `react-ts` template. Next: a hero and a pricing section, dark theme, plain CSS variables instead of a UI kit.' },
      { id: 'n4', taskId: 't3', role: 'tool', toolName: 'Write', text: JSON.stringify({ file_path: 'landing/src/Hero.tsx' }), at: ago(8) },
      { id: 'n5', taskId: 't3', role: 'tool', toolName: 'Write', text: JSON.stringify({ file_path: 'landing/src/Pricing.tsx' }), at: ago(6) },
      { id: 'n6', taskId: 't3', role: 'tool', toolName: 'Edit', text: JSON.stringify({ file_path: 'landing/src/App.tsx' }), at: ago(4) },
    ],
    t4: [
      { id: 'e1', taskId: 't4', role: 'user', text: 'Deploy to production', at: ago(100) },
      { id: 'e2', taskId: 't4', role: 'tool', toolName: 'Bash', text: JSON.stringify({ command: 'git push origin main && ./scripts/deploy.sh --env production --wait' }), at: ago(99) },
      { id: 'e3', taskId: 't4', role: 'assistant', at: ago(98), text: 'Pushing now. The deploy script is running.' },
    ],
    t5: [
      { id: 'c1', taskId: 't5', role: 'user', text: 'Show me the deploy client code', at: ago(200) },
      { id: 'c2', taskId: 't5', role: 'assistant', at: ago(199), text: 'Here it is. An unbroken identifier also appears: `' + 'superlongidentifier_'.repeat(8) + '`.\n\n```ts\n' + LONG_LINE + '\nconsole.log(result.status);\n```\n\nA real table:\n\n| Step | Command | Time | Notes |\n|:--|:--|--:|:-:|\n| Build | `npm run build` | 12.4 s | **ok** |\n| Test | `npm test \\| tail -40` | 98 s | see [log](https://example.com/log) |\n| Deploy | `./deploy.sh --env production --wait` | 3 s | a long note that wraps because the column is capped at a sensible width and must not push the page sideways |\n| Short |\n\nAnd a table-ish list:\n1. Build\n2. Push\n3. Deploy\n\n# A top heading\n## Second level\nDone.' },
    ],
    t6: [],
    t7: [
      { id: 'b1', taskId: 't7', role: 'user', fromAgentId: 'zealot', text: 'Migrate the auth module to the new session API and keep the tests green. Reply with the diff summary only.', at: ago(20) },
      { id: 'b2', taskId: 't7', role: 'tool', toolName: 'Edit', text: JSON.stringify({ file_path: 'src/auth/session.ts' }), at: ago(18) },
      { id: 'b3', taskId: 't7', role: 'assistant', at: ago(15), text: 'Migrated `src/auth/session.ts` to `createSession()` and updated 4 call sites. Tests pass (38/38).' },
    ],
  };
  if (f('bridge')) {
    db.messages.t1.push(
      { id: 'br0', taskId: 't1', role: 'tool', toolName: 'ToolSearch', toolUseId: 'u0', text: JSON.stringify({ query: 'select:mcp__legion__ask' }), at: ago(31) },
      { id: 'br1', taskId: 't1', role: 'tool', toolName: 'mcp__legion__agents', toolUseId: 'u1', text: '{}', at: ago(31) },
      { id: 'br1r', taskId: 't1', role: 'tool', resultFor: 'u1', text: JSON.stringify([{ id: 'builder', name: 'Builder', status: 'idle', role: 'coding' }, { id: 'scout', name: 'Scout', status: 'working', role: 'research' }]), at: ago(31) },
      { id: 'br2', taskId: 't1', role: 'tool', toolName: 'mcp__legion__ask', toolUseId: 'u2', text: JSON.stringify({ agent: 'builder', message: 'Migrate the auth module to the new session API and keep the tests green. Reply with the diff summary only.' }), at: ago(30) },
      { id: 'br2r', taskId: 't1', role: 'tool', resultFor: 'u2', text: JSON.stringify({ taskId: 't7', status: 'done', model: 'sonnet', result: 'Migrated src/auth/session.ts to createSession() and updated 4 call sites. Tests pass (38/38).' }), at: ago(29) },
      { id: 'br3', taskId: 't1', role: 'tool', toolName: 'mcp__legion__tell', toolUseId: 'u3', text: JSON.stringify({ agent: 'scout', message: 'Find the RFC that describes refresh token rotation and summarise it in 5 bullets.' }), at: ago(29) },
      { id: 'br3r', taskId: 't1', role: 'tool', resultFor: 'u3', text: JSON.stringify({ taskId: 't4' }), at: ago(29) },
      { id: 'br4', taskId: 't1', role: 'user', text: '[Reply from Scout \u00b7 task t4] RFC 6749 section 6 covers refresh; rotation is in the OAuth 2.1 draft. Five bullets: 1) issue a new refresh token on every use...', at: ago(28), fromAgentId: 'scout' },
    );
  }
  if (f('many')) for (let i = 0; i < 16; i++) db.tasks.push({ id: 'x' + i, agentId: 'zealot', title: 'Extra task number ' + (i + 1), status: 'done', source: 'ui', requestedModel: 'auto', createdAt: ago(1000 + i), updatedAt: ago(10 + i) });
  if (f('approval')) {
    db.approvals.push({ id: 'apA', taskId: 't1', agentId: 'zealot', toolName: 'Bash', summary: 'sudo apt-get install -y imagemagick && convert -version', input: {}, at: ago(1) });
    db.approvals.push({ id: 'apB', taskId: 't3', agentId: 'builder', toolName: 'Bash', summary: 'rm -rf node_modules && npm install', input: {}, at: ago(1) });
    db.approvals.push({ id: 'apC', taskId: 't3', agentId: 'builder', toolName: 'mcp__github__create_pull_request', summary: 'owner=acme repo=legion title="Landing page" ' + 'body=' + 'lorem ipsum dolor sit amet '.repeat(12), input: {}, at: ago(1) });
  }
  return db;
}
const CATALOG = {
  commands: [
    { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '[instructions]', builtin: true },
    { name: 'review', description: 'Review a pull request', argumentHint: '[pr-number]', builtin: true },
    { name: 'init', description: 'Initialize a CLAUDE.md file with codebase documentation', argumentHint: '', builtin: true },
    { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '', builtin: true },
    { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
    { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', argumentHint: '', builtin: true },
    { name: 'simplify', description: 'Review changed code for reuse, quality, and efficiency, then fix any issues', argumentHint: '[focus]', aliases: ['tidy'] },
    { name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files', argumentHint: '' },
    { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality', argumentHint: '[brief]' },
    { name: 'data:analyze', description: 'Answer data questions, from quick lookups to full analyses', argumentHint: '[question]' },
  ],
  models: [
    { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Fast and capable. Best for everyday coding and research.', resolvedModel: 'claude-sonnet-5-5' },
    { value: 'opus', displayName: 'Opus 5.5', description: 'Deepest reasoning. Slower and uses more of your plan.', resolvedModel: 'claude-opus-5-5' },
    { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest and lightest. Good for quick lookups.', resolvedModel: 'claude-haiku-4-5' },
  ],
};
let catalogCalls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 100;
const scenarios = new Map();
const scnKey = (raw) => (raw || 'x');
function ctxFor(raw) {
  const key = scnKey(raw);
  if (!scenarios.has(key)) { const flags = new Set(key.split('.')); scenarios.set(key, { key, flags, db: makeDb(flags), clients: new Set() }); }
  return scenarios.get(key);
}
const emit = (ctx, e) => { for (const c of ctx.clients) c.write(`data: ${JSON.stringify(e)}\n\n`); };

async function demo(ctx, task) {
  const { db } = ctx; const tid = task.id;
  emit(ctx, { type: 'mascot', mood: 'thinking' });
  await sleep(700);
  emit(ctx, { type: 'mascot', mood: 'hacking' });
  const tool = { id: 'd' + seq++, taskId: tid, role: 'tool', toolName: 'Bash', text: JSON.stringify({ command: 'ls -la && cat package.json' }), at: now() };
  (db.messages[tid] ??= []).push(tool); emit(ctx, { type: 'message', message: tool });
  await sleep(600);
  const ap = { id: 'ap' + seq++, taskId: tid, agentId: task.agentId, toolName: 'Bash', summary: 'rm -rf node_modules && npm install', input: {}, at: now() };
  db.approvals.push(ap); emit(ctx, { type: 'approval.requested', approval: ap });
  await sleep(1200);
  const text = 'Sure \u2014 here is a **quick plan**:\n\n1. Inspect the project\n2. Install deps\n3. Run the build\n\nStarting now with `npm install`.';
  for (const ch of text.match(/.{1,6}/gs)) { emit(ctx, { type: 'message.delta', taskId: tid, text: ch }); await sleep(35); }
  const msg = { id: 'd' + seq++, taskId: tid, role: 'assistant', text, at: now() };
  (db.messages[tid] ??= []).push(msg); emit(ctx, { type: 'message', message: msg });
  Object.assign(task, { status: 'done', model: 'sonnet', costUsd: 0.013, turns: 2, updatedAt: now() });
  emit(ctx, { type: 'task.updated', task }); emit(ctx, { type: 'mascot', mood: 'success' });
  await sleep(3500); emit(ctx, { type: 'mascot', mood: 'idle' });
}

// A small fake "VM desktop" (640x400 PNG, sniffed fine by browsers even under a jpeg mime): a terminal with coloured text rows.
function png() {
  const w = 640, h = 400; const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const C = { prompt: [124, 255, 178], cmd: [230, 233, 239], flag: [255, 204, 102], out: [120, 130, 147], ok: [110, 200, 140], path: [130, 170, 255] };
  const rows = []; // [{ y, segs: [{ x, w, c }] }]
  for (let i = 0, y = 78; y < 344; i++, y += 15) {
    const segs = []; let x = 62;
    if (i % 4 === 0) {
      segs.push({ x, w: 7, c: C.prompt }); x += 16;
      for (const c of [C.cmd, C.flag, C.path, C.cmd]) { const sw = 24 + Math.floor(rnd() * 56); segs.push({ x, w: sw, c }); x += sw + 8; if (x > 420) break; }
    } else {
      const n = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) { const sw = 30 + Math.floor(rnd() * 90); if (x + sw > 560) break; segs.push({ x, w: sw, c: rnd() > 0.82 ? C.ok : C.out }); x += sw + 10; }
    }
    rows.push({ y, segs });
  }
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      let px = [26 + (x >> 5), 34 + (y >> 4), 66 + (x >> 4) - (y >> 5)]; // desktop gradient
      if (y < 22) px = [18, 22, 30];
      else if (x >= 40 && x < 600 && y >= 40 && y < 368) {
        px = y < 62 ? [42, 46, 56] : [15, 18, 23];
        if (y >= 46 && y < 56 && x >= 52 && x < 100 && ((x - 52) % 18) < 10) px = [[255, 107, 107], [255, 204, 102], [124, 255, 178]][Math.floor((x - 52) / 18)];
        if (y >= 62) for (const r of rows) if (y >= r.y && y < r.y + 6) for (const sg of r.segs) if (x >= sg.x && x < sg.x + sg.w) px = sg.c;
      } else if (x >= 38 && x < 602 && y >= 38 && y < 370) px = [8, 10, 14]; // window shadow
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2];
    }
  }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const shot = png().toString('base64');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}); } catch { r({}); } }); });
const doctorChecks = (pass, boat) => [
  { id: 'node', label: 'Node.js \u2265 20', ok: true, detail: 'v22.11.0' },
  { id: 'claude-signin', label: 'Claude sign-in', ok: true, detail: 'you@example.com \u00b7 Max subscription' },
  boat ? { id: 'boat', label: 'boat.dev', ok: true, detail: 'Key accepted \u00b7 3 sandboxes' } : { id: 'boat', label: 'boat.dev', ok: true, detail: 'Not configured (agent VMs disabled)', fix: 'Add your key in Settings \u2192 boat.dev' },
  { id: 'workspace', label: 'Workspace writable', ok: true, detail: '~/.legion/workspaces' },
  ...(pass ? [] : [{ id: 'mcp', label: 'MCP server "github"', ok: false, detail: 'Failed to start: spawn npx ENOENT. The server never answered the initialize request within 10 seconds and was killed by the supervisor.', fix: 'npm i -g npx && legion-core --restart' }]),
];

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x'); const p = url.pathname;

  if (!p.startsWith('/api') && !p.startsWith('/__') && p !== '/health') { // static dist-ui
    const f = path.join(root, p === '/' ? 'index.html' : p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
  }
  if (p === '/health') return send(res, 200, { ok: true, version: '0.1.0', pid: process.pid });
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || url.searchParams.get('scn');
  const ctx = ctxFor(auth); const { db, flags } = ctx;
  if (p === '/__emit' && req.method === 'POST') { emit(ctx, await readBody(req)); return send(res, 200, { ok: true }); }
  if (p === '/__approval' && req.method === 'POST') { const b = await readBody(req); const ap = { id: 'ap' + seq++, taskId: b.taskId || 't3', agentId: b.agentId || 'builder', toolName: 'Bash', summary: b.summary || 'sudo apt-get install -y imagemagick && convert -version', input: {}, at: now() }; db.approvals.push(ap); emit(ctx, { type: 'approval.requested', approval: ap }); return send(res, 200, ap); }
  if (flags.has('down')) return send(res, 503, { error: 'Cannot reach Legion core' });
  if (p === '/api/events') {
    if (flags.has('offline')) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hi\n\n'); ctx.clients.add(res); req.on('close', () => ctx.clients.delete(res)); return;
  }
  if (p === '/api/state') return send(res, 200, { version: '0.1.0', agents: db.agents, tasks: db.tasks.filter((t) => url.searchParams.get('archived') === '1' || !t.archived).reverse(), vms: db.vms, approvals: db.approvals, boatConfigured: db.boat, auth: 'claude-login' });
  if (p === '/api/config') return send(res, 200, { port: PORT, authToken: '***', claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { apiKey: '***', baseUrl: 'https://boat.dev/api/v1' }, mcpServers: {} });
  if (p === '/api/doctor') return send(res, 200, doctorChecks(flags.has('doctor-pass'), db.boat));
  if (p === '/api/catalog') {
    catalogCalls++; await sleep(Number(process.env.CATALOG_DELAY || 350));
    if (process.env.CATALOG_FAIL && !(url.searchParams.get('refresh') && catalogCalls > 1 && process.env.CATALOG_FAIL === 'once')) return send(res, 200, { commands: [], models: [], fetchedAt: now(), error: 'Claude Code probe timed out' });
    return send(res, 200, { ...CATALOG, fetchedAt: now() });
  }
  if (p === '/api/vms') return send(res, 200, db.vms);
  if (p === '/api/approvals') return send(res, 200, db.approvals);
  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, db.settings);
  if (p === '/api/settings' && req.method === 'PATCH') {
    const b = await readBody(req); const st = db.settings;
    await sleep(250);
    if (b.claude?.maxTurns !== undefined && !(Number.isInteger(b.claude.maxTurns) && b.claude.maxTurns >= 1 && b.claude.maxTurns <= 1000)) return send(res, 400, { error: 'claude.maxTurns must be a whole number between 1 and 1000' });
    if (b.boat?.baseUrl !== undefined && !/^https?:\/\/[^ ]+$/.test(b.boat.baseUrl)) return send(res, 400, { error: 'boat.baseUrl must be an http(s) URL' });
    if (b.claude?.auth === 'api-key' && !st.claude.apiKeySet && !b.claude.apiKey) return send(res, 400, { error: 'claude.apiKey is required when auth is "api-key"' });
    if (b.mcpServers) for (const [n, e] of Object.entries(b.mcpServers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(n)) return send(res, 400, { error: `mcpServers.${n}: name may only use letters, numbers, - and _` });
      if ((!e.type || e.type === 'stdio') && !e.command) return send(res, 400, { error: `mcpServers.${n}: command is required` });
      if ((e.type === 'http' || e.type === 'sse') && !/^https?:\/\//.test(e.url || '')) return send(res, 400, { error: `mcpServers.${n}: url must start with http:// or https://` });
    }
    const hint = (k) => '\u2026' + String(k).slice(-4);
    if (b.claude) { const { apiKey, executablePath, ...rest } = b.claude; Object.assign(st.claude, rest); if (apiKey !== undefined) { st.claude.apiKeySet = !!apiKey; st.claude.apiKeyHint = apiKey ? hint(apiKey) : undefined; } if (executablePath !== undefined) st.claude.executablePath = executablePath || undefined; }
    if (b.boat) { if (b.boat.baseUrl) st.boat.baseUrl = b.boat.baseUrl; if (b.boat.apiKey !== undefined) { st.boat.apiKeySet = !!b.boat.apiKey; st.boat.apiKeyHint = b.boat.apiKey ? hint(b.boat.apiKey) : undefined; db.boat = !!b.boat.apiKey; } }
    if (b.mcpServers) st.mcpServers = b.mcpServers;
    emit(ctx, { type: 'settings.updated', settings: st });
    return send(res, 200, st);
  }
  if (p === '/api/settings/boat/test' && req.method === 'POST') {
    const b = await readBody(req); await sleep(700);
    const key = b.apiKey || (db.settings.boat.apiKeySet ? 'saved' : ''); db.lastTestBase = b.baseUrl;
    if (!key) return send(res, 200, { ok: false, detail: 'No key to test. Paste one first.' });
    if (/bad$/i.test(key)) return send(res, 200, { ok: false, detail: 'boat.dev rejected this key (401 unauthorized).' });
    return send(res, 200, { ok: true, detail: 'Connected \u00b7 3 sandboxes' });
  }
  let m;
  if ((m = p.match(/^\/api\/tasks\/([^/]+)$/)) && req.method === 'PATCH') {
    const task = db.tasks.find((t) => t.id === m[1]); if (!task) return send(res, 404, { error: 'not found' });
    const b = await readBody(req); if (typeof b.archived === 'boolean') task.archived = b.archived; if (typeof b.title === 'string' && b.title.trim()) task.title = b.title.trim().slice(0, 120);
    task.updatedAt = now(); emit(ctx, { type: 'task.updated', task }); return send(res, 200, task);
  }
  if ((m = p.match(/^\/api\/tasks\/([^/]+)$/)) && req.method === 'DELETE') {
    const task = db.tasks.find((t) => t.id === m[1]); if (!task) return send(res, 404, { error: 'not found' });
    if (task.status === 'running') return send(res, 409, { error: 'Task is running. Stop it first.' });
    db.tasks = db.tasks.filter((t) => t !== task); delete db.messages[task.id]; emit(ctx, { type: 'task.deleted', taskId: task.id }); return send(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/tasks\/([^/]+)$/))) { const task = db.tasks.find((t) => t.id === m[1]); return task ? send(res, 200, { task, messages: db.messages[task.id] || [] }) : send(res, 404, { error: 'not found' }); }
  if (p === '/api/tasks' && req.method === 'POST') {
    const b = await readBody(req);
    if (flags.has('apierr')) return send(res, 500, { error: 'Could not start the run: the Claude Code subprocess failed to spawn (EACCES on C:\\Users\\you\\.legion\\workspaces\\zealot). Check the folder permissions and try again.' });
    let task = b.continueTaskId && db.tasks.find((t) => t.id === b.continueTaskId);
    if (!task) { task = { id: 't' + seq++, agentId: b.agentId, title: String(b.prompt).slice(0, 60), status: 'running', source: 'ui', requestedModel: b.model || 'auto', createdAt: now(), updatedAt: now() }; db.tasks.push(task); }
    task.status = 'running'; task.updatedAt = now();
    const um = { id: 'u' + seq++, taskId: task.id, role: 'user', text: b.prompt, at: now() };
    (db.messages[task.id] ??= []).push(um);
    setTimeout(() => { emit(ctx, { type: 'task.updated', task }); emit(ctx, { type: 'message', message: um }); if (!process.env.NO_DEMO && !flags.has('nodemo')) void demo(ctx, task); }, 50);
    return send(res, 201, task);
  }
  if ((m = p.match(/^\/api\/approvals\/([^/]+)$/))) { db.approvals = db.approvals.filter((a) => a.id !== m[1]); emit(ctx, { type: 'approval.resolved', approvalId: m[1], allowed: true }); return send(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/(start|stop|exec|desktop|screenshot)$/))) {
    const [, id, act] = m;
    const rec0 = db.vms.find((v) => v.agentId === id);
    if (act === 'screenshot') return rec0 && rec0.state === 'running' && !flags.has('noshot') ? send(res, 200, { format: 'jpeg', data: shot }) : send(res, 409, { error: 'VM not running' });
    if (act === 'exec') return send(res, 200, { exitCode: 0, stdout: 'Linux boat 6.1.0\nuptime: 12 min', stderr: '' });
    if (act === 'desktop') return send(res, 200, { url: 'https://boat.dev/desktop/x' });
    if (flags.has('apierr')) return send(res, 502, { error: 'boat.dev: sandbox quota exceeded for this API key (limit 3). Archive an unused sandbox and try again.' });
    const rec = vm({ agentId: id, state: act === 'start' ? 'running' : 'archived' });
    db.vms = db.vms.filter((v) => v.agentId !== id).concat(rec); emit(ctx, { type: 'vm.updated', vm: rec }); return send(res, 200, rec);
  }
  if (p === '/api/agents' && req.method === 'POST') { const b = await readBody(req); const a = agent(b.name.toLowerCase().replace(/\W+/g, '-'), b.name, b.emoji || '\u2726', b.description || '', b.model || 'auto', b.approval || 'ask', !!b.vm?.enabled); db.agents.push(a); return send(res, 201, a); }
  if ((m = p.match(/^\/api\/agents\/([^/]+)$/))) { const a = db.agents.find((x) => x.id === m[1]); if (req.method === 'PATCH' && a) { Object.assign(a, await readBody(req)); return send(res, 200, a); } if (req.method === 'DELETE') { db.agents = db.agents.filter((x) => x.id !== m[1]); return send(res, 200, { ok: true }); } }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`mock legion core on http://127.0.0.1:${PORT}`));
