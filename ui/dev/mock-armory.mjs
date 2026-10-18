// Dev-only mock of the Armory and skill finder routes for visual checks (used by mock-server.mjs).
// Scenario flags (page token, dot separated):
//   fnd-all      every finder switch on, local ranker, rerank on with spend
//   fnd-suggest-on | fnd-suggest-auto   the "Suggest each turn" select
//   nosearch     the search tool is off
//   fnd-local    the local model ranker is chosen
//   mdl-dl | mdl-ready | mdl-err        the local model state at start (default: not installed)
//   mdl-hang     "Get model" never finishes (stays downloading)
//   provremote   the provider is on another computer (the disclosure keeps the full line)
//   prov         one embedding-capable provider is set up; with fnd-provider the provider ranker is chosen
//   noticeseen   the first-contact notice was already answered
//   chatoff      "Show suggestions in chat" is off
//   unm60        60 switched-on skills that no listing finds
const mk = (id, source, description, state = 'on', extra = {}) => ({
  id, name: id.includes(':') ? id.split(':')[1] : id, description, source, plugin: source === 'claude-plugin' ? id.split(':')[0] : null,
  state, stateIsDefault: false, agents: 'all', path: source === 'claude-builtin' ? null : `/x/${id}/SKILL.md`, manualOnlyInFrontmatter: false, ...extra,
});
const SKILLS = [
  mk('legion-armory:invoice-pdf-export', 'yours', 'Export invoices to PDF documents for accounting'),
  mk('legion-armory:release-notes', 'yours', 'Write release notes from merged pull requests'),
  mk('legion-armory:db-tune', 'yours', 'Tune database queries and indexes'),
  mk('legion-armory:design-polish', 'yours', 'Polish typography, spacing and colour for pages'),
  mk('sp:invoice-audit', 'claude-plugin', 'Audit invoices, export pdf accounting'),
  mk('sp:brainstorming', 'claude-plugin', 'Explore intent and design before building', 'manual'),
  mk('verify', 'claude-builtin', 'Verify a change works', 'on', { fit: 'fit' }),
  mk('travel-plan', 'claude-personal', 'Plan a trip with a budget', 'off'),
];

export function armoryState(flags) {
  const all = flags.has('fnd-all');
  const finder = {
    suggest: flags.has('fnd-suggest-auto') ? 'auto' : all || flags.has('fnd-suggest-on'), searchTool: !flags.has('nosearch'), subagents: true,
    ranker: all || flags.has('fnd-local') ? 'local' : flags.has('fnd-provider') ? 'provider' : 'keyword', rerank: all, rerankMonthlyUsd: all ? 2 : 1,
    slimListing: false, k: 3, threshold: 'balanced', chatLine: !flags.has('chatoff'), noticeSeen: flags.has('noticeseen') || all,
    ...(flags.has('fnd-provider') ? { providerId: 'local-embed', providerModel: 'nomic-embed-text' } : {}),
  };
  const model = flags.has('mdl-dl') ? { state: 'downloading', progress: 0.4 } : flags.has('mdl-ready') || all ? { state: 'ready', bytes: 143_000_000 }
    : flags.has('mdl-err') ? { state: 'error', error: 'The download stopped: the connection was reset. Nothing was installed.' } : { state: 'not-installed' };
  return { finder, model, spend: { month: '2026-10', spentUsd: all ? 0.37 : 0, capUsd: finder.rerankMonthlyUsd } };
}

// The real tokenizer drops stopwords, so a stopword never shows as a matched word.
const STOP = new Set(['the', 'for', 'and', 'with', 'from', 'that', 'this', 'you', 'are', 'your', 'please', 'can', 'will', 'how', 'what']);
const words = (t) => (String(t).toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w));

export async function armoryRoutes({ ctx, req, res, p, url, send, readBody, sleep }) {
  if (!p.startsWith('/api/armory') && p !== '/api/providers') return false;
  const { flags } = ctx;
  const a = (ctx.armory ??= armoryState(flags));
  const m = req.method;
  if (p === '/api/providers') {
    send(res, 200, { providers: flags.has('prov') || flags.has('fnd-provider') ? [{ id: 'local-embed', label: flags.has('provremote') ? 'Embeddings cloud' : 'Local server', baseUrl: flags.has('provremote') ? 'https://api.embed.example/v1' : 'http://localhost:11434/v1', enabled: true, models: ['nomic-embed-text', 'bge-small'] }] : [], maxTurns: 40, maxToolCallsPerTurn: 20, dropped: [], cannotDo: [] });
    return true;
  }
  if (p === '/api/armory' && m === 'GET') {
    const unm = flags.has('unm60') ? Array.from({ length: 60 }, (_, i) => `design:skill-${String(i + 1).padStart(2, '0')}-with-a-longer-name`) : [];
    send(res, 200, { inherit: true, ccNoticeSeen: true, pluginRoot: '/p', allowSkillShell: false, finder: a.finder, skills: SKILLS, discoveredAt: new Date().toISOString(), discovery: 'sdk', discoveryReason: null, discoveryPlugins: 2, unmatchedOn: unm.length, unmatchedOnIds: unm });
    return true;
  }
  if (p === '/api/armory/finder' && m === 'GET') { send(res, 200, a.finder); return true; }
  if (p === '/api/armory/finder' && m === 'POST') { Object.assign(a.finder, await readBody(req)); for (const k of Object.keys(a.finder)) if (a.finder[k] === '') delete a.finder[k]; a.spend.capUsd = a.finder.rerankMonthlyUsd; send(res, 200, a.finder); return true; }
  if (p === '/api/armory/finder/model' && m === 'GET') { send(res, 200, a.model); return true; }
  if (p === '/api/armory/finder/model/get' && m === 'POST') {
    a.model = { state: 'downloading', progress: 0.4 };
    if (flags.has('mdl-hang')) { await sleep(600000); }
    await sleep(900); a.model = { state: 'ready', bytes: 143_000_000 }; send(res, 200, { ok: true, status: a.model }); return true;
  }
  if (p === '/api/armory/finder/model' && m === 'DELETE') { a.model = { state: 'not-installed' }; send(res, 200, a.model); return true; }
  if (p === '/api/armory/finder/rerank-spend') { send(res, 200, a.spend); return true; }
  if (p === '/api/armory/finder/test' && m === 'POST') {
    const b = await readBody(req); const q = String(b.query ?? '').trim();
    if (!q) { send(res, 400, { error: 'Type a message to test' }); return true; }
    const qw = new Set(words(q));
    const rows = SKILLS.filter((s) => s.state === 'on').map((s) => {
      const matched = [...new Set(words(`${s.id} ${s.description}`))].filter((w) => qw.has(w));
      return { id: s.id, score: matched.length * 7.3 + 0.4, bm25: matched.length * 7.3 + 0.4, ...(a.finder.ranker === 'local' ? { cosine: 0.9 } : {}), boost: s.id.endsWith('pdf-export') ? 1.1 : 1, matched, thirdParty: s.source === 'claude-plugin' || s.source === 'imported' };
    }).filter((r) => r.matched.length).sort((x, y) => y.score - x.score).slice(0, 10);
    send(res, 200, { query: q, scope: b.agent ? 'agent' : 'on', candidates: SKILLS.filter((s) => s.state === 'on').length, rows });
    return true;
  }
  if (p === '/api/armory/effective-all') { send(res, 200, { agents: [] }); return true; }
  if (p === '/api/armory/notice-seen') { send(res, 200, { ccNoticeSeen: true }); return true; }
  send(res, 404, { error: 'no route' });
  return true;
}
