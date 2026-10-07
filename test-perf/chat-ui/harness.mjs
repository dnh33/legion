// Playwright harness for the chat composer queue and the copy menu: a REAL core (real Engine, real HTTP server, real store on disk) with a
// SCRIPTED Claude SDK, plus a static server for a built UI directory. No network, no real model.
//
//   const env = await startFake({ ui: '/tmp/m/wt-chat/dist-ui', repo: '/tmp/m/wt-chat' });
//   env.calls            every prompt the "SDK" received, in order: [{ agent, prompt, at }]
//   await env.stop();
//
// The fake SDK answers by marker in the prompt text:
//   [slow:N]      works for N ms (default 1500), streaming a few text deltas; stops at once when interrupted
//   [approval]    asks for approval of a Bash call (agent "careful" has approval=ask), then finishes when answered
//   [error]       ends with an error result (after the delay when combined with [slow])
//   [tool]        runs a (fake) Bash tool call with a result, then answers 'Used a tool.'
//   [md]          answers with a rich markdown reply (heading, bold, list, link, code block) for the copy tests
//   anything else answers immediately: "echo: <prompt>"
// Safety: the data dir is /tmp/m/wt-chat-home-<port>, removed on stop; the core listens on 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCorePath, proxyToCore, serveStatic } from '../lib/same-origin.mjs';

export const SECRET = 'c'.repeat(64);
export const TOKEN = 'chat-ui-token';

export const MD_REPLY = [
  '## Plan',
  '',
  'Here is the **plan** with `inline code` and a [docs link](https://example.com/docs).',
  '',
  '- first item',
  '- second *item* with emphasis',
  '',
  '1. step one',
  '2. step two',
  '',
  '```ts',
  'const x = 1;',
  'console.log(x);',
  '```',
  '',
  'Done.',
].join('\n');

export async function startFake({ ui, repo, port = 48600, agents } = {}) {
  const imp = (p) => import(pathToFileURL(path.join(repo, 'dist', p)).href);
  const [{ ApprovalBroker }, { EventBus }, { Engine }, { Store }, { createServer }, { SettingsService }, { defaultConfig }] = await Promise.all([
    imp('src/core/approvals.js'), imp('src/core/bus.js'), imp('src/core/engine.js'), imp('src/core/store.js'), imp('src/core/server.js'), imp('src/core/settings.js'), imp('src/shared/config.js'),
  ]);
  const home = `/tmp/m/wt-chat-home-${port}`;
  if (!home.startsWith('/tmp/m/wt-chat-home')) throw new Error('unsafe home');
  fs.rmSync(home, { recursive: true, force: true });
  const dataDir = path.join(home, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port, authToken: TOKEN, workspaceDir: path.join(home, 'ws'), claude: { auth: 'claude-login', inheritClaudeCodeSettings: true, maxTurns: 40 }, boat: { baseUrl: 'https://boat.test' }, mcpServers: {} }));
  const store = new Store(dataDir);
  const mk = (id, name, emoji, approval) => ({ id, name, emoji, description: `${name} (test agent)`, systemPrompt: '', model: 'sonnet', vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval, mcpServers: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  for (const a of agents ?? [mk('zealot', 'Marshal', '⚡', 'full'), mk('scout', 'Scout', '🔭', 'full'), mk('careful', 'Careful', '🛡', 'ask')]) store.upsertAgent(a);
  const bus = new EventBus();
  const config = defaultConfig(); config.authToken = TOKEN; config.workspaceDir = path.join(home, 'ws'); config.port = port;
  const calls = [];
  let sid = 0;
  const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
  const queryFn = (p) => {
    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    const agent = path.basename(p.options.cwd);
    calls.push({ agent, prompt, at: Date.now() });
    const signal = p.options.abortController?.signal;
    const id = `sess-${++sid}`;
    const delta = (text) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, num_turns: 1, session_id: id, ...extra });
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: id };
      const slow = /\[slow(?::(\d+))?\]/.exec(prompt);
      if (slow) {
        const ms = Number(slow[1] || 1500);
        yield delta('Working on it');
        const end = Date.now() + ms;
        while (Date.now() < end && !signal?.aborted) { await sleep(Math.min(100, end - Date.now()), signal); if (!signal?.aborted) yield delta('.'); }
        if (signal?.aborted) return;
        if (prompt.includes('[error]')) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['scripted failure'], total_cost_usd: 0, num_turns: 1, session_id: id }; return; }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: `slow done: ${prompt}` }] } };
        yield result(`slow done: ${prompt}`); return;
      }
      if (prompt.includes('[approval]')) {
        const ok = p.options.canUseTool ? await p.options.canUseTool('Bash', { command: 'ls -la' }) : { behavior: 'allow' };
        const text = ok.behavior === 'allow' ? `approved: ${prompt}` : `denied: ${prompt}`;
        yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }; yield result(text); return;
      }
      if (prompt.includes('[error]')) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['scripted failure'], total_cost_usd: 0, num_turns: 1, session_id: id }; return; }
      if (prompt.includes('[tool]')) {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la /secret-tool-input' } }] } };
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'TOOL-OUTPUT-MARKER' }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Used a tool.' }] } }; yield result('Used a tool.'); return;
      }
      if (prompt.includes('[md]')) { yield { type: 'assistant', message: { content: [{ type: 'text', text: MD_REPLY }] } }; yield result(MD_REPLY); return; }
      const text = `echo: ${prompt}`;
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }; yield result(text);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  };
  const approvals = new ApprovalBroker(bus, {});
  const vms = { touch() {}, ensureRunning: async () => ({}), stop: async () => ({}), status: (id) => ({ agentId: id, state: 'none' }), exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), desktopUrl: async () => 'https://desk.example/x', screenshot: async () => ({ format: 'jpeg', data: '' }) };
  const engine = new Engine({ store, bus, vms, approvals, config, queryFn, boatConfigured: () => false, maxConcurrent: 4 });
  engine.setModules([]);
  const settings = new SettingsService({ config, bus, configPath: path.join(dataDir, 'config.json'), dataDir, onBoatChange: () => undefined });
  const server = createServer({
    config, store, bus, engine, vms, approvals, boatConfigured: () => false, modules: [], bsvEnabled: () => false, settings, adminSecret: SECRET,
    doctor: async () => [{ id: 'claude', label: 'Claude sign-in', ok: true, detail: 'ok' }],
    catalog: async () => ({ commands: [{ name: 'review', description: 'Review a PR', argumentHint: '<pr>' }], models: [], fetchedAt: new Date().toISOString() }),
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });

  const uiPort = port + 1;
  // ONE origin for the UI and the API (../lib/same-origin.mjs): the core's guard refuses a UI served from a second port.
  const stat = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/__calls') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(calls)); return; }
    if (isCorePath(u)) { proxyToCore(port, req, res); return; }
    serveStatic(ui, req, res);
  }).listen(uiPort, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 150));

  return {
    base: `http://127.0.0.1:${uiPort}`, token: TOKEN, admin: SECRET, uiUrl: `http://127.0.0.1:${uiPort}/index.html`, home, calls, bus, store, engine,
    prompts: () => calls.map((c) => c.prompt),
    async stop() {
      for (const id of engine.running()) engine.cancel(id);
      stat.closeAllConnections?.(); stat.close();
      server.closeAllConnections?.(); await new Promise((r) => server.close(() => r()));
      await store.flush?.();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
