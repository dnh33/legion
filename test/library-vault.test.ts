/**
 * Library v1, stage B: vault import of inline #tags and props, and the one-way mirror into <vault>/legion/ only.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createKnowledgeModule } from '../src/core/kg/index.js';
import { agentActor, HUMAN } from '../src/core/kg/types.js';
import { exportLibrary, exportVault, importVault as importVaultRaw, inlineTags, isLibraryExportable, parseFrontmatter, vaultFileName } from '../src/core/kg/vault.js';
import { makeFakes, start, TOKEN, AUTH } from './helpers-c.js';
import { mkGraph, tmpDir } from './kg-helpers.js';

/** These tests exercise the user-initiated import (the app's route); the held-only default is covered in library-review-integrity. */
const importVault = (g: Parameters<typeof importVaultRaw>[0], dir: string, actor?: Parameters<typeof importVaultRaw>[2]) =>
  importVaultRaw(g, dir, actor, { userInitiated: true });

const tree = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(root, p).split('\\').join('/'), createHash('sha1').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
};
const bot = (id: string, task = 't1') => agentActor(id, { taskId: task });

test('import: inline #tags become tags, #decision/#mistake/#pattern/#idea pick the type, imported notes are human trust', () => {
  const vault = tmpDir();
  writeFileSync(join(vault, 'a.md'), '# Use Postgres\n\nWe chose it. #decision #db/storage\n');
  writeFileSync(join(vault, 'b.md'), '---\ntags: [ops]\n---\n# Broke prod\n\nThe deploy broke. #mistake and #incident\n');
  writeFileSync(join(vault, 'c.md'), '# Retry with jitter\n\n#pattern\n');
  writeFileSync(join(vault, 'd.md'), '# Talking robots\n\nAn idea. #Idea\n');
  writeFileSync(join(vault, 'e.md'), '---\ntype: lesson\n---\n# Explicit type\n\n#decision wins? no: the frontmatter does\n');
  writeFileSync(join(vault, 'f.md'), '# Not tags\n\nIssue #123, colour ok, `#code`, ```\n#fenced\n```, [link](#anchor), https://x.test/page#frag, [[Other#Heading]], word#glued\n');
  const { g } = mkGraph();
  const r = importVault(g, vault);
  assert.equal(r.created, 6);
  const by = (t: string) => g.findByTitle(HUMAN, t)[0]!;
  assert.equal(by('Use Postgres').type, 'decision');
  assert.deepEqual(by('Use Postgres').tags.sort(), ['db/storage', 'decision']);
  assert.equal(by('Broke prod').type, 'mistake');
  assert.deepEqual(by('Broke prod').tags.sort(), ['incident', 'mistake', 'ops']);
  assert.equal(by('Retry with jitter').type, 'pattern');
  assert.equal(by('Talking robots').type, 'idea');
  assert.equal(by('Explicit type').type, 'lesson');
  assert.deepEqual(by('Not tags').tags, [], `no false tags, got ${by('Not tags').tags}`);
  for (const n of g.allNodes(HUMAN).filter((x) => x.props?.vaultPath)) assert.equal(n.trust, 'human', n.title);
  assert.deepEqual(inlineTags('a #x b\n#y_z, (#nope) #9 #a-b'), ['x', 'y_z', 'a-b']);
});

test('import snapshots the graph first', () => {
  const { g, dir } = mkGraph();
  g.upsertNode(HUMAN, { title: 'Existing note' });
  const vault = tmpDir();
  writeFileSync(join(vault, 'a.md'), '# New\n');
  const before = readFileSync(join(dir, 'graph.jsonl'), 'utf8');
  assert.ok(before.includes('Existing note'));
  importVault(g, vault);
  const baks = readdirSync(dir).filter((f) => /^graph\.jsonl\.bak-\d+$/.test(f));
  assert.ok(baks.length >= 1);
  // the snapshot holds the pre-import graph, not an empty or post-import file
  const snap = readFileSync(join(dir, baks[baks.length - 1]!), 'utf8');
  assert.equal(snap, before);
  assert.ok(!snap.includes('"New"'), 'the imported note is not in the snapshot');
  assert.ok(readFileSync(join(dir, 'graph.jsonl'), 'utf8').includes('"New"'), 'but it is in the live graph');
});

test('frontmatter round-trips props (including quoted keys) and tags; reserved props never travel', () => {
  const { g } = mkGraph();
  const n = g.upsertNode(HUMAN, { title: 'Props note', body: 'body', tags: ['a'], props: { owner: 'Dana', 'two words': 'x: y', count: 3, ok: true, vaultPath: 'x.md' }, confidence: 0.5 }).node;
  const out = tmpDir();
  exportVault(g, HUMAN, out);
  const text = readFileSync(join(out, vaultFileName(n)), 'utf8');
  assert.match(text, /props:\n  owner: "Dana"\n  "two words": "x: y"\n  count: 3\n  ok: true\n/);
  assert.doesNotMatch(text, /vaultPath/);
  const fm = parseFrontmatter(text).data;
  assert.deepEqual(fm.props, { owner: 'Dana', 'two words': 'x: y', count: 3, ok: true });
  assert.deepEqual(fm.tags, ['a']);
  // and back into a fresh graph
  const vault = tmpDir();
  cpSync(join(out, vaultFileName(n)), join(vault, 'props-note.md'));
  const { g: g2 } = mkGraph();
  importVault(g2, vault);
  const back = g2.findByTitle(HUMAN, 'Props note')[0]!;
  assert.deepEqual(back.props, { owner: 'Dana', 'two words': 'x: y', count: 3, ok: true, vaultPath: 'props-note.md' });
  assert.equal(back.confidence, 0.5);
  // a file may not set reserved props
  writeFileSync(join(vault, 'sneaky.md'), '---\nprops:\n  reviewed: true\n  stub: true\n  vaultPath: "elsewhere"\n  fine: 1\n---\n# Sneaky\n');
  importVault(g2, vault);
  assert.deepEqual(g2.findByTitle(HUMAN, 'Sneaky')[0]!.props, { fine: 1, vaultPath: 'sneaky.md' });
});

function libraryFixture() {
  const { g } = mkGraph();
  const vault = tmpDir();
  mkdirSync(join(vault, 'Projects', 'deep'), { recursive: true });
  writeFileSync(join(vault, 'Home.md'), '# Home\n\nmy own note #decision\n');
  writeFileSync(join(vault, 'Projects', 'deep', 'Idea.md'), '# Deep idea\n\nlinks to [[Home]]\n');
  writeFileSync(join(vault, 'Projects', 'data.csv'), 'a,b\n1,2\n');
  writeFileSync(join(vault, '.obsidian-note'), 'hidden');
  importVault(g, vault);
  const human = g.findByTitle(HUMAN, 'Home')[0]!;
  const good = g.upsertNode(bot('alpha'), { title: 'Bot decision: use queues', type: 'decision', body: '## Chose\nqueues', props: { kind: 'x' }, tags: ['arch'] }).node;
  g.link(bot('alpha'), { from: good.id, to: human.id, rel: 'relates' });
  const good2 = g.upsertNode(bot('beta'), { title: '../../etc/passwd: weird / title', type: 'pattern', body: 'b' }).node;
  const untrusted = g.upsertNode(bot('alpha'), { title: 'UNTRUSTED-TITLE web finding', untrusted: true, sources: [{ ref: 'https://x.test' }] }).node;
  g.link(bot('alpha'), { from: good.id, to: untrusted.id, rel: 'cites' });
  const pending = g.upsertNode(agentActor('alpha', { taskId: 'tt', taint: () => true }), { title: 'PENDING-TAINTED note', scope: 'shared' }).node;
  const priv = g.upsertNode(bot('alpha'), { title: 'PRIVATE-NOTE', scope: 'agent:alpha' }).node;
  const old = g.upsertNode(bot('alpha'), { title: 'SUPERSEDED-NOTE' }).node;
  g.supersede(bot('alpha'), old.id, good2.id);
  const acceptedTainted = g.upsertNode(agentActor('beta', { taskId: 'tz', taint: () => true }), { title: 'ACCEPTED-TAINTED note', scope: 'shared' }).node;
  g.acceptPending(HUMAN, acceptedTainted.id);
  return { g, vault, human, good, good2, untrusted, pending, priv, old, acceptedTainted };
}

test('vault tree diff: the library mirror writes only active, non-untrusted shared bot notes, only under legion/, and touches nothing else', () => {
  const f = libraryFixture();
  const before = tree(f.vault);
  const r = exportLibrary(f.g, f.vault);
  const after = tree(f.vault);
  assert.equal(r.dir, join(f.vault, 'legion'));
  assert.equal(r.written, 2);
  // every pre-existing file is byte-identical; every new file is inside legion/
  for (const [p, h] of before) assert.equal(after.get(p), h, `${p} was changed`);
  const added = [...after.keys()].filter((p) => !before.has(p));
  // the two notes plus the mirror marker that lets import skip the folder wherever it ends up
  assert.equal(added.length, 3);
  assert.ok(added.includes('legion/.legion-mirror'));
  for (const p of added) assert.ok(p.startsWith('legion/'), `${p} is outside legion/`);
  assert.ok(added.includes(`legion/decision/${vaultFileName(f.good)}`));
  assert.ok(added.includes(`legion/pattern/${vaultFileName(f.good2)}`));
  assert.match(vaultFileName(f.good2), /^[a-z0-9-]+--n_[0-9a-f]+\.md$/, 'the slug cannot escape the folder');
  // and nothing of the excluded notes anywhere in the tree
  const all = [...after.keys()].map((p) => readFileSync(join(f.vault, p), 'utf8')).join('\n');
  for (const bad of ['UNTRUSTED-TITLE', 'PENDING-TAINTED', 'PRIVATE-NOTE', 'SUPERSEDED-NOTE', 'ACCEPTED-TAINTED']) assert.doesNotMatch(all, new RegExp(bad), bad);
  assert.equal(isLibraryExportable(f.human), false);
  // the exported file: frontmatter with props, body, a link to the human note, none to the untrusted one
  const text = readFileSync(join(f.vault, 'legion', 'decision', vaultFileName(f.good)), 'utf8');
  assert.match(text, /^---\nid: "n_/);
  assert.match(text, /props:\n  kind: "x"/);
  assert.match(text, /## Chose\nqueues/);
  assert.match(text, /relates:: \[\[Home\]\]/);
  assert.doesNotMatch(text, /cites::/);
  // retiring a note removes only its own file inside legion/; a hand-made file there is left alone
  writeFileSync(join(f.vault, 'legion', 'README.md'), 'mine');
  f.g.supersede(HUMAN, f.good2.id, f.good.id);
  const r2 = exportLibrary(f.g, f.vault);
  assert.equal(r2.removedStale, 1);
  assert.equal(r2.written, 1);
  const after2 = tree(f.vault);
  assert.ok(!after2.has(`legion/pattern/${vaultFileName(f.good2)}`));
  assert.ok(after2.has('legion/README.md'));
  for (const [p, h] of before) assert.equal(after2.get(p), h, `${p} was changed by the second export`);
  // idempotent
  const snap = tree(f.vault);
  exportLibrary(f.g, f.vault);
  assert.deepEqual([...tree(f.vault)], [...snap]);
});

test('import never reads the legion/ mirror back (no loop, no relabelling bot notes as the human\'s)', () => {
  const f = libraryFixture();
  exportLibrary(f.g, f.vault);
  const { g: g2 } = mkGraph();
  const r = importVault(g2, f.vault);
  assert.equal(r.files, 2, 'only the two human files');
  assert.equal(g2.findByTitle(HUMAN, 'Bot decision: use queues').length, 0);
  // and re-importing into the same graph leaves the bot note as it was
  importVault(f.g, f.vault);
  assert.equal(f.g.getNode(HUMAN, f.good.id)!.trust, 'agent');
});

test('exportLibrary refuses to write through a legion/ link', () => {
  const { g } = mkGraph();
  g.upsertNode(bot('alpha'), { title: 'Bot note', type: 'pattern' });
  const vault = tmpDir();
  const outside = tmpDir();
  try { symlinkSync(outside, join(vault, 'legion')); } catch { return; /* no symlinks on this platform */ }
  assert.throws(() => exportLibrary(g, vault), /not write through it/);
  assert.deepEqual(readdirSync(outside), []);
});

test('exportLibrary never writes through a leaf symlink inside legion/ (skips only where symlinks are unsupported)', (t) => {
  const { g } = mkGraph();
  const n = g.upsertNode(bot('alpha'), { title: 'Bot note', type: 'pattern' }).node;
  const vault = tmpDir();
  exportLibrary(g, vault);
  const leaf = join(vault, 'legion', 'pattern', vaultFileName(n));
  const outsideDir = tmpDir();
  const target = join(outsideDir, 'precious.txt');
  writeFileSync(target, 'PRECIOUS');
  try { rmSync(leaf); symlinkSync(target, leaf); } catch (e) { t.skip(`symlinks are not supported here: ${(e as Error).message}`); return; }
  g.upsertNode(bot('alpha'), { id: n.id, body: 'changed so the file is rewritten' });
  exportLibrary(g, vault);
  assert.equal(readFileSync(target, 'utf8'), 'PRECIOUS', 'the file the link pointed at is untouched');
  assert.equal(lstatSync(leaf).isSymbolicLink(), false, 'the link was replaced by a regular file');
  assert.match(readFileSync(leaf, 'utf8'), /changed so the file is rewritten/);
});

test('exportLibrary on an empty or missing vault dir creates only legion/', () => {
  const { g } = mkGraph();
  const root = join(tmpDir(), 'fresh-vault');
  const r = exportLibrary(g, root);
  assert.equal(r.written, 0);
  assert.deepEqual(readdirSync(root), ['legion']);
  assert.ok(statSync(join(root, 'legion')).isDirectory());
});

// ---------------------------------------------------------------- route

const open: Array<() => Promise<void>> = [];
after(async () => { for (const c of open) await c().catch(() => undefined); });

test('route: POST /api/kg/export mode library mirrors into legion/; the default export is unchanged; bad mode is 400', async () => {
  const f = makeFakes();
  const mod = createKnowledgeModule({ config: f.ctx.config, store: f.ctx.store, bus: f.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: tmpDir(), bsvEnabled: () => false });
  f.ctx.modules = [mod];
  const srv = await start(f.ctx);
  open.push(async () => { await mod.dispose?.(); await srv.close(); });
  const call = async (body: unknown) => {
    const r = await fetch(srv.base + '/api/kg/export', { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const g = mod.graph();
  g.upsertNode(HUMAN, { title: 'Human note' });
  g.upsertNode(bot('alpha'), { title: 'Bot note for the mirror', type: 'pattern' });
  const lib = tmpDir();
  const a = await call({ dir: lib, mode: 'library' });
  assert.equal(a.status, 200);
  assert.equal(a.body.written, 1);
  const libFiles = [...tree(lib).keys()];
  assert.ok(libFiles.length >= 2 && libFiles.every((p) => p.startsWith('legion/')), 'everything lands under legion/');
  assert.ok(libFiles.includes('legion/.legion-mirror'));
  const all = tmpDir();
  const b = await call({ dir: all });
  assert.equal(b.body.written, 2);
  assert.ok(existsSync(join(all, vaultFileName(g.findByTitle(HUMAN, 'Human note')[0]!))));
  assert.equal((await call({ dir: all, mode: 'nope' })).status, 400);
});
