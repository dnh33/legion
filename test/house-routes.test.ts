/**
 * The house layer's owner-facing HTTP surface: GET /api/house and the adopt/unadopt pair.
 *
 * The point of these tests is the boundary, not the plumbing. Adoption is the one thing that makes an owner-authored
 * file count as a rule, so the questions that matter are: can it be reached from a run (it must not be on the MCP
 * client's short list), does it refuse a path outside the layer, and does it stay fail-closed on a file that is not
 * there. ADR 0010.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createHouseModule } from '../src/core/house/index.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import type { HouseModule } from '../src/core/house/index.js';
import { ADOPTED_NAME, MANIFEST_NAME } from '../src/core/house/trust.js';

const roots: string[] = [];
const scratch = (): string => { const r = mkdtempSync(join(tmpdir(), 'legion-house-routes-')); roots.push(r); return r; };
after(() => { for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } } });

interface Rig { mod: HouseModule; root: string; data: string; layer: string; call: (m: string, p: string, body?: unknown) => Promise<unknown>; paths: string[] }

/** A packaged-shaped install: the layer only under dist/context-layer, as a released install has it. */
function rig(): Rig {
  const root = scratch();
  const staged = join(root, 'dist', 'context-layer');
  mkdirSync(join(staged, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(staged, 'context'), { recursive: true });
  // The whole shipped set, as scripts/copy-static.mjs stages it. A partial fixture would report files missing that a
  // real install has, and the test would be asserting the fixture's shape rather than the module's behaviour.
  writeFileSync(join(staged, 'AGENTS.md'), '# Working on Legion\n\nRule 1: the admin gate is default-deny.\n', 'utf8');
  writeFileSync(join(staged, 'CONTEXT.md'), '# Glossary\n', 'utf8');
  writeFileSync(join(staged, 'context', 'README.md'), '# context\n', 'utf8');
  for (const f of ['SESSION-LOG.md', 'VERSIONING.md', 'RELEASE-NOTES.md', 'ARCHITECTURE.md', 'TESTING.md']) {
    writeFileSync(join(staged, 'docs', f), `# ${f}\n\nLegion's own words.\n`, 'utf8');
  }
  writeFileSync(join(staged, 'docs', 'adr', 'README.md'), '# ADRs\n\nIndex.\n', 'utf8');
  writeFileSync(join(staged, 'docs', 'adr', '0004-dependency-hash.md'), '# 0004\n\nHash content.\n', 'utf8');

  const data = scratch();
  const deps = { dataDir: data, bsvEnabled: () => false } as unknown as ModuleDeps;
  const mod = createHouseModule(deps, { repoRoot: root });
  const paths: string[] = [];
  const handlers = new Map<string, (c: unknown) => unknown>();
  const add: RouteAdder = (m, p, h) => { paths.push(`${m} ${p}`); handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  mod.routes?.(add);
  assert.ok(handlers.has('GET /api/house'), 'the module registered its read route');
  const call = async (m: string, p: string, body?: unknown): Promise<unknown> => {
    const h = handlers.get(`${m} ${p}`);
    assert.ok(h, `no route ${m} ${p}`);
    return h({ req: { headers: {} }, body, params: [], url: new URL('http://x/') });
  };
  return { mod, root, data, layer: join(data, 'context'), call, paths };
}

describe('house routes: what is in the layer', () => {
  it('reports every file with its trust state, so the owner can see what is a rule and what is not', async () => {
    const r = rig();
    writeFileSync(join(r.layer, 'my-note.md'), '# My rules\n\nAlways answer in Danish.\n', 'utf8');
    const out = await r.call('GET', '/api/house') as { files: { path: string; trust: string }[]; missing: string[] };
    const byPath = new Map(out.files.map((f) => [f.path, f.trust]));
    assert.equal(byPath.get('AGENTS.md'), 'shipped', 'what the app shipped is trusted');
    assert.equal(byPath.get('my-note.md'), 'untrusted', 'the owner\'s own file is not, until approved');
    assert.deepEqual(out.missing, [], 'a packaged install has nothing missing once the layer is staged');
  });

  it('does not list the trust manifests as content', async () => {
    const r = rig();
    const out = await r.call('GET', '/api/house') as { files: { path: string }[] };
    const paths = out.files.map((f) => f.path);
    assert.ok(!paths.includes(MANIFEST_NAME));
    assert.ok(!paths.includes(ADOPTED_NAME));
  });

  it('serves no tools and no preamble when the layer is empty, so an agent is not told about rules that are not there', async () => {
    const bare = scratch();
    const deps = { dataDir: scratch(), bsvEnabled: () => false } as unknown as ModuleDeps;
    const mod = createHouseModule(deps, { repoRoot: bare });
    assert.equal(mod.hasContent(), false, 'a root with nothing in it is an empty layer');
    assert.deepEqual(mod.mcpServers?.({} as never), {}, 'no house tools on an empty layer');
    assert.equal(mod.preamble?.({ approval: 'ask' } as never), '', 'and no preamble either');
  });
});

describe('house routes: adoption is the owner\'s own door', () => {
  it('approves a file and reports it adopted, and the read is then unwrapped', async () => {
    const r = rig();
    writeFileSync(join(r.layer, 'my-note.md'), '# My rules\n\nAlways answer in Danish.\n', 'utf8');
    const res = await r.call('POST', '/api/house/adopt', { path: 'my-note.md' }) as { trust: string; sha256: string };
    assert.equal(res.trust, 'adopted');
    assert.match(res.sha256, /^[0-9a-f]{64}$/, 'the approval is the hash of the bytes approved');
    const view = await r.call('GET', '/api/house') as { files: { path: string; trust: string }[] };
    assert.equal(view.files.find((f) => f.path === 'my-note.md')?.trust, 'adopted');
  });

  it('refuses a path that leaves the context folder, which is the attack that matters', async () => {
    // state.json holds the bearer token. A path from a request is untrusted input like any other.
    const r = rig();
    for (const bad of ['../state.json', '../../.legion/state.json', 'docs/../../../etc/passwd']) {
      await assert.rejects(() => r.call('POST', '/api/house/adopt', { path: bad }), /outside the house context folder/,
        `should have refused ${bad}`);
    }
    assert.ok(!existsSync(join(r.data, '..', '.legion', 'state.json')), 'and nothing outside was touched');
  });

  it('refuses a body with no usable path rather than approving something unintended', async () => {
    const r = rig();
    for (const body of [{}, { path: '' }, { path: '   ' }, { path: 42 }, null, 'nope']) {
      await assert.rejects(() => r.call('POST', '/api/house/adopt', body), /path is required/);
    }
  });

  it('reports a missing file honestly instead of recording an approval for it', async () => {
    const r = rig();
    await assert.rejects(() => r.call('POST', '/api/house/adopt', { path: 'not-here.md' }), /No readable file/);
    // The manifest is not written at all when there was nothing to record, so "no entry for it" covers both shapes.
    const recorded = existsSync(join(r.layer, ADOPTED_NAME))
      ? JSON.parse(readFileSync(join(r.layer, ADOPTED_NAME), 'utf8')) as Record<string, string>
      : {};
    assert.equal(recorded['not-here.md'], undefined, 'nothing was recorded');
  });

  it('withdrawing says what the file is NOW, because a shipped file stays trusted', async () => {
    // Saying "untrusted" after withdrawing an approval from a file the app also shipped would be a lie: the bytes are
    // still the app's own, so it is trusted by that fact alone.
    const r = rig();
    await r.call('POST', '/api/house/adopt', { path: 'AGENTS.md' });
    const res = await r.call('POST', '/api/house/unadopt', { path: 'AGENTS.md' }) as { trust: string; approvalRemoved: boolean };
    assert.equal(res.approvalRemoved, true);
    assert.equal(res.trust, 'shipped', 'the owner\'s approval went, the app\'s own bytes did not');
  });

  it('withdrawing from a file that was never approved says so, and changes nothing', async () => {
    const r = rig();
    const res = await r.call('POST', '/api/house/unadopt', { path: 'AGENTS.md' }) as { approvalRemoved: boolean; trust: string };
    assert.equal(res.approvalRemoved, false);
    assert.equal(res.trust, 'shipped');
  });

  it('an approved file loses the approval when it is edited, with no second door to renew it', async () => {
    const r = rig();
    const path = join(r.layer, 'my-note.md');
    writeFileSync(path, '# My rules\n\nVersion one.\n', 'utf8');
    await r.call('POST', '/api/house/adopt', { path: 'my-note.md' });
    writeFileSync(path, '# My rules\n\nVersion two, written by someone else.\n', 'utf8');
    const view = await r.call('GET', '/api/house') as { files: { path: string; trust: string }[] };
    assert.equal(view.files.find((f) => f.path === 'my-note.md')?.trust, 'untrusted',
      'an edit must invalidate the approval: the approval was for those bytes');
  });

  it('exposes adoption over HTTP only, never as a tool an agent could call', async () => {
    // The security argument in ADR 0010. If a run could reach adoption, "the owner approved this" would mean nothing.
    const r = rig();
    assert.ok(r.paths.includes('POST /api/house/adopt'), 'the owner has a door');
    const { buildHouseServer } = await import('../src/core/house/tools.js');
    const server = buildHouseServer({} as never, undefined, { root: () => r.layer }) as { tools?: { name: string }[] };
    const names = (server.tools ?? []).map((t) => t.name);
    assert.ok(!names.includes('house_adopt'), 'and no tool named house_adopt');
    assert.ok(!names.some((n) => n.includes('adopt')), `no adopt tool at all, found ${JSON.stringify(names)}`);
  });

  it('keeps the adoption routes admin-only, so neither an agent nor an MCP client can reach them', async () => {
    // The security argument in ADR 0010, checked at the gate rather than described. `isClientRoute` is the short list the
    // MCP-client bearer token opens; anything not on it is admin-only, and the admin secret lives only in the Electron
    // main process for the length of a launch. So an outside caller cannot approve anything.
    const { isClientRoute } = await import('../src/core/admin.js');
    for (const p of ['/api/house', '/api/house/adopt', '/api/house/unadopt']) {
      assert.equal(isClientRoute('GET', p), false, `GET ${p} must not be client-reachable`);
      assert.equal(isClientRoute('POST', p), false, `POST ${p} must not be client-reachable`);
    }
    // And the gate is default-deny: a valid client bearer token still gets 403 on adoption, because the route is not on
    // the short list. This is the check that makes "admin-only" mean something.
    const { gate } = await import('../src/core/admin.js');
    const denied = gate({ method: 'POST', path: '/api/house/adopt', adminOk: false, bearerOk: true, hasSecret: true });
    assert.equal(denied.allow, false, 'a valid client token must not open adoption');
    assert.equal((denied as { status: number }).status, 403, 'and it is a 403, not a 404 that would confirm the route exists');
    const allowed = gate({ method: 'POST', path: '/api/house/adopt', adminOk: true, bearerOk: false, hasSecret: true });
    assert.equal(allowed.allow, true, 'the app, holding the admin secret, may');
  });
});