import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Graph } from '../src/core/kg/graph.js';
import { KgError } from '../src/core/kg/types.js';
import { exportVault, importVault as importVaultRaw, parseFrontmatter, VAULT_MAX_FILE_BYTES, VAULT_MAX_FILES, vaultFileName } from '../src/core/kg/vault.js';
import { KG_LIMITS } from '../src/shared/kg.js';
import { ALPHA, BETA, HUMAN, logLines, mkGraph, note, tmpDir } from './kg-helpers.js';

/** These tests exercise the user-initiated import (the app's route); the held-only default is covered in library-review-integrity. */
const importVault = (g: Parameters<typeof importVaultRaw>[0], dir: string, actor?: Parameters<typeof importVaultRaw>[2]) =>
  importVaultRaw(g, dir, actor, { userInitiated: true });

const write = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const tree = (root: string): string[] => {
  const out: string[] = [];
  const visit = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) visit(p); else out.push(`${p.slice(root.length)}:${statSync(p).size}:${readFileSync(p, 'utf8').length}`); } };
  visit(root);
  return out.sort();
};

// ---------------------------------------------------------------- frontmatter

test('frontmatter parser handles scalars, flow and block lists, source maps, CRLF and comments', () => {
  const text = [
    '---', 'id: "n_1"', "title: 'It''s here'", 'type: lesson', 'tags: [a, "b c", d]', 'confidence: 0.75', 'flag: true', '# a comment',
    'aliases:', '  - one', '  - two', 'sources:', '  - ref: "https://x.test/a"', '    licence: "CC BY 4.0"', '    untrusted: true', '  - ref: plain/path.md', '---', '', 'Body here', '',
  ].join('\r\n');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.id, 'n_1');
  assert.equal(data.title, "It's here");
  assert.deepEqual(data.tags, ['a', 'b c', 'd']);
  assert.equal(data.confidence, 0.75);
  assert.equal(data.flag, true);
  assert.deepEqual(data.aliases, ['one', 'two']);
  assert.deepEqual(data.sources, [{ ref: 'https://x.test/a', licence: 'CC BY 4.0', untrusted: true }, { ref: 'plain/path.md' }]);
  assert.equal(body.trim(), 'Body here');
  assert.deepEqual(parseFrontmatter('no frontmatter\n').data, {});
  assert.equal(parseFrontmatter('no frontmatter\n').body, 'no frontmatter\n');
});

// ---------------------------------------------------------------- export

test('export writes <slug>--<id>.md with frontmatter, body and a Links section', () => {
  const { g } = mkGraph();
  const a = g.upsertNode(HUMAN, { type: 'lesson', title: 'Wallet basics: keys & seeds', body: 'Keep keys out of Legion.\n\nSee [[Testnet practice]].', tags: ['safety', 'wallet'], confidence: 0.9, sources: [{ ref: 'https://docs.test', licence: 'CC BY 4.0' }, { ref: 'https://web.test', untrusted: true }] }).node;
  const b = note(g, 'Testnet practice');
  g.link(HUMAN, { from: a.id, to: b.id, rel: 'depends_on' });
  const out = tmpDir();
  const r = exportVault(g, HUMAN, join(out, 'vault'));
  assert.equal(r.written, 2);
  assert.deepEqual(readdirSync(join(out, 'vault')).sort(), [`testnet-practice--${b.id}.md`, `wallet-basics-keys-seeds--${a.id}.md`].sort());
  assert.equal(vaultFileName(a), `wallet-basics-keys-seeds--${a.id}.md`);
  const text = readFileSync(join(out, 'vault', vaultFileName(a)), 'utf8');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.id, a.id);
  assert.equal(data.type, 'lesson');
  assert.deepEqual(data.tags, ['safety', 'wallet']);
  assert.equal(data.scope, 'shared');
  assert.equal(data.createdBy, 'human');
  assert.equal(data.updatedAt, a.updatedAt);
  assert.deepEqual(data.sources, [{ ref: 'https://docs.test', licence: 'CC BY 4.0' }, { ref: 'https://web.test', untrusted: true }]);
  assert.match(body, /Keep keys out of Legion\./);
  assert.match(body, /\n## Links\n\n- depends_on:: \[\[Testnet practice\]\]\n$/);
});

test('export only writes what the actor can see, and removes the old file of a renamed node', () => {
  const { g, bsv } = mkGraph();
  note(g, 'Shared one');
  g.upsertNode(ALPHA, { title: 'Alpha private', scope: 'agent:alpha' });
  g.upsertNode(HUMAN, { id: 'bsv-1', title: 'Bsv lesson', scope: 'bsv', sources: [{ ref: 'https://s.test' }] });
  const dir = tmpDir();
  assert.equal(exportVault(g, BETA, dir).written, 1);
  assert.equal(exportVault(g, HUMAN, dir).written, 2, 'human sees shared + private, bsv is off');
  bsv.on = true;
  assert.equal(exportVault(g, HUMAN, dir).written, 3);
  const n = g.search(HUMAN, 'shared')[0]!.node;
  g.upsertNode(HUMAN, { id: n.id, title: 'Renamed page' });
  const r = exportVault(g, HUMAN, dir);
  assert.equal(r.removedStale, 1);
  const names = readdirSync(dir);
  assert.ok(names.includes(`renamed-page--${n.id}.md`));
  assert.ok(!names.includes(`shared-one--${n.id}.md`));
});

// ---------------------------------------------------------------- round trip

test('export then import into a fresh graph reproduces notes, tags and typed links, and is idempotent', () => {
  const src = mkGraph();
  const a = src.g.upsertNode(HUMAN, { type: 'concept', title: 'Alpha', body: 'About alpha.', tags: ['x', 'y'], confidence: 0.4 }).node;
  const b = src.g.upsertNode(HUMAN, { type: 'decision', title: 'Beta [draft] | v2', body: 'Beta body' }).node;
  const c = note(src.g, 'Gamma');
  src.g.link(HUMAN, { from: a.id, to: b.id, rel: 'depends_on' });
  src.g.link(HUMAN, { from: a.id, to: c.id, rel: 'contradicts' });
  src.g.link(HUMAN, { from: c.id, to: a.id, rel: 'cites' });
  const vault = tmpDir();
  exportVault(src.g, HUMAN, vault);

  const dst = mkGraph();
  const r1 = importVault(dst.g, vault);
  assert.deepEqual({ files: r1.files, created: r1.created, updated: r1.updated, stubs: r1.stubs, skipped: r1.skipped.length }, { files: 3, created: 3, updated: 0, stubs: 0, skipped: 0 });
  const byTitle = (t: string) => dst.g.findByTitle(HUMAN, t)[0]!;
  const a2 = byTitle('Alpha');
  assert.deepEqual([a2.type, a2.body, a2.tags, a2.confidence, a2.scope], ['concept', 'About alpha.', ['x', 'y'], 0.4, 'shared']);
  const b2 = dst.g.search(HUMAN, 'beta')[0]!.node;
  assert.equal(b2.type, 'decision');
  const edges = dst.g.edgesOf(HUMAN, a2.id, 'out').map((e) => `${e.rel}:${dst.g.getNode(HUMAN, e.to)!.title}`).sort();
  assert.deepEqual(edges, ['contradicts:Gamma', 'depends_on:Beta [draft] | v2'].sort(), 'link text is sanitised in the file but resolved through its id hint');
  assert.equal(dst.g.stats(HUMAN).edges, 3);
  assert.equal(dst.g.lint(HUMAN).danglingEdges.length, 0);

  // second import: nothing changes, nothing is appended
  const before = { stats: dst.g.stats(HUMAN), log: logLines(dst.file).length };
  const r2 = importVault(dst.g, vault);
  assert.deepEqual({ created: r2.created, updated: r2.updated, unchanged: r2.unchanged, edges: r2.edges, stubs: r2.stubs }, { created: 0, updated: 0, unchanged: 3, edges: 0, stubs: 0 });
  assert.deepEqual(dst.g.stats(HUMAN), before.stats);
  assert.equal(logLines(dst.file).length, before.log);
});

test('importing the export of the same graph does not duplicate; a change made in the vault waits in the Inbox as a proposal', () => {
  const { g } = mkGraph();
  const a = note(g, 'One', { body: 'first' });
  const b = note(g, 'Two');
  g.link(HUMAN, { from: a.id, to: b.id, rel: 'teaches' });
  const vault = tmpDir();
  exportVault(g, HUMAN, vault);
  // untouched export: nothing changes, nothing is proposed
  const r0 = importVault(g, vault);
  assert.equal(r0.unchanged, 2);
  assert.equal(g.inbox(HUMAN).length, 0);
  // edit the vault like a human would in Obsidian
  const f = join(vault, vaultFileName(a));
  writeFileSync(f, readFileSync(f, 'utf8').replace('first', 'first, edited in the vault'));
  const r = importVault(g, vault);
  assert.equal(r.created, 0);
  assert.equal(r.held, 1, 'a file that names an existing note by id may be planted: the change is a proposal');
  assert.equal(g.getNode(HUMAN, a.id)!.body, 'first', 'the live note is untouched until the human accepts');
  const rows = g.inbox(HUMAN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'edit');
  g.acceptPending(HUMAN, rows[0]!.id);
  assert.equal(g.findByTitle(HUMAN, 'One').filter((n) => n.status === undefined)[0]!.body, 'first, edited in the vault');
  assert.equal(g.stats(HUMAN).edges >= 1, true);
  // after accepting, the same files change nothing and propose nothing
  const r2 = importVault(g, vault);
  assert.equal(r2.unchanged, 2);
  assert.equal(r2.updated, 0);
  assert.equal(g.inbox(HUMAN).length, 0);
});

test('a link to one of two nodes that share a title round-trips to the right one', () => {
  const src = mkGraph();
  const from = note(src.g, 'Source');
  note(src.g, 'Twin', { body: 'first twin' });
  const twin2 = note(src.g, 'Twin', { body: 'second twin' });
  src.g.link(HUMAN, { from: from.id, to: twin2.id, rel: 'cites' });
  const vault = tmpDir();
  exportVault(src.g, HUMAN, vault);
  const dst = mkGraph();
  importVault(dst.g, vault);
  const f2 = dst.g.findByTitle(HUMAN, 'Source')[0]!;
  const target = dst.g.getNode(HUMAN, dst.g.edgesOf(HUMAN, f2.id)[0]!.to)!;
  assert.equal(target.body, 'second twin');
});

// ---------------------------------------------------------------- import of a plain vault

test('import reads a plain Obsidian vault: titles, tags, wikilinks, stubs, sources, ignored folders', () => {
  const { g } = mkGraph();
  const vault = tmpDir();
  write(vault, 'Alpha.md', '---\ntitle: Alpha Page\ntags: [one, two]\n---\nAlpha talks about [[Beta]] and [[Beta|the second]] and [[Missing Thing#Heading]].\n```\n[[In Code]]\n```\nInline `[[Also Code]]`.\n');
  write(vault, 'notes/Beta.md', '# Beta Heading\n\nBeta body links back to [[Alpha Page]].\n');
  write(vault, 'notes/deep/plain-file.md', 'no title anywhere, just text\n');
  write(vault, '.obsidian/config.md', '# Hidden\n');
  write(vault, '.hidden-note.md', '# Hidden note\n');
  write(vault, 'image.png', 'not markdown');
  write(vault, 'readme.txt', 'nope');
  const snapshot = tree(vault);
  const r = importVault(g, vault);
  assert.equal(r.files, 3);
  assert.equal(r.created, 3);
  assert.equal(r.stubs, 2, '"Beta" and "Missing Thing" are unresolved; links in code are ignored');
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(tree(vault), snapshot, 'the vault is read-only');

  const alpha = g.findByTitle(HUMAN, 'Alpha Page')[0]!;
  assert.equal(alpha.type, 'note');
  assert.deepEqual(alpha.tags, ['one', 'two']);
  assert.deepEqual(alpha.sources, [{ ref: 'Alpha.md' }]);
  assert.equal(alpha.createdBy, 'human');
  const beta = g.findByTitle(HUMAN, 'Beta Heading')[0]!;
  assert.deepEqual(beta.sources, [{ ref: 'notes/Beta.md' }]);
  assert.ok(g.findByTitle(HUMAN, 'plain-file')[0], 'title falls back to the filename');
  assert.equal(g.findByTitle(HUMAN, 'Hidden').length + g.findByTitle(HUMAN, 'Hidden note').length, 0);
  const stub = g.findByTitle(HUMAN, 'Missing Thing')[0]!;
  assert.equal(stub.type, 'entity');
  assert.equal(stub.props!.stub, true);
  assert.equal(g.findByTitle(HUMAN, 'In Code').length + g.findByTitle(HUMAN, 'Also Code').length, 0);
  // [[Beta]] has no note called Beta (its title is "Beta Heading"), so it becomes a stub; [[Alpha Page]] resolves to the real note
  assert.equal(g.findByTitle(HUMAN, 'Beta')[0]!.props!.stub, true);
  const rels = g.edgesOf(HUMAN, alpha.id, 'out').map((e) => `${e.rel}:${g.getNode(HUMAN, e.to)!.title}`).sort();
  assert.deepEqual(rels, ['mentions:Beta', 'mentions:Missing Thing']);
  assert.deepEqual(g.edgesOf(HUMAN, beta.id, 'out').map((e) => `${e.rel}:${e.to}`), [`mentions:${alpha.id}`]);
});

test('import is idempotent by source ref and a later note adopts an earlier stub', () => {
  const { g } = mkGraph();
  const vault = tmpDir();
  write(vault, 'a.md', '# A\n\nSee [[B]].\n');
  const r1 = importVault(g, vault);
  assert.deepEqual([r1.created, r1.stubs, r1.edges], [1, 1, 1]);
  const stubId = g.findByTitle(HUMAN, 'B')[0]!.id;
  const log = logLines(g.file).length;
  const r2 = importVault(g, vault);
  assert.deepEqual([r2.created, r2.updated, r2.unchanged, r2.stubs, r2.edges], [0, 0, 1, 0, 0]);
  assert.equal(logLines(g.file).length, log);
  assert.equal(g.stats(HUMAN).nodes, 2);

  // the vault grows a real note B: it takes over the stub instead of creating a duplicate
  write(vault, 'b.md', '# B\n\nNow B has a body.\n');
  const r3 = importVault(g, vault);
  assert.equal(r3.created, 0);
  assert.equal(g.stats(HUMAN).nodes, 2);
  const b = g.getNode(HUMAN, stubId)!;
  assert.equal(b.props!.stub, undefined);
  assert.match(b.body, /Now B has a body/);
  assert.equal(g.edgesOf(HUMAN, stubId, 'in').length, 1, 'the earlier link now points at the real note');

  // editing a file updates the same node (matched by its source ref), it never creates a copy
  write(vault, 'b.md', '# B\n\nEdited.\n');
  const r4 = importVault(g, vault);
  assert.deepEqual([r4.created, r4.updated], [0, 1]);
  assert.equal(g.stats(HUMAN).nodes, 2);
  assert.match(g.getNode(HUMAN, stubId)!.body, /Edited/);
});

test('import never lets file content choose scope, author or trust', () => {
  const { g } = mkGraph();
  const vault = tmpDir();
  write(vault, 'x.md', '---\ntitle: Planted\nscope: bsv\ncreatedBy: system\ntype: lesson\nid: bsv-evil\n---\nbody\n');
  importVault(g, vault);
  const n = g.findByTitle(HUMAN, 'Planted')[0]!;
  assert.equal(n.scope, 'shared');
  assert.equal(n.createdBy, 'human');
  assert.equal(n.type, 'lesson', 'a valid type is honoured');
  assert.notEqual(n.id, 'bsv-evil');
  assert.equal(g.search(ALPHA, 'planted').length, 1);
});

test('import enforces its limits: dot folders, symlinks, file size, body length, file count', () => {
  const { g } = mkGraph();
  const vault = tmpDir();
  const outside = tmpDir();
  write(outside, 'secret.md', '# Outside secret\n');
  symlinkSync(join(outside, 'secret.md'), join(vault, 'link.md'));
  symlinkSync(outside, join(vault, 'linked-dir'));
  write(vault, 'huge.md', '# Huge\n' + 'x'.repeat(VAULT_MAX_FILE_BYTES));
  write(vault, 'long-body.md', '# Long body\n' + 'x'.repeat(KG_LIMITS.bodyChars + 10));
  write(vault, 'long-title.md', '# ' + 't'.repeat(KG_LIMITS.titleChars + 1) + '\n\nbody');
  write(vault, 'fine.md', '# Fine\n');
  const r = importVault(g, vault);
  assert.equal(r.files, 1);
  assert.equal(g.findByTitle(HUMAN, 'Outside secret').length, 0, 'symlinks are not followed');
  assert.deepEqual(r.skipped.map((s) => s.path).sort(), ['huge.md', 'long-body.md', 'long-title.md']);
  assert.match(r.skipped.find((s) => s.path === 'huge.md')!.reason, /larger than 200 KB/);
  assert.match(r.skipped.find((s) => s.path === 'long-body.md')!.reason, /body longer than 20000/);
  assert.equal(g.stats(HUMAN).nodes, 1);

  const many = tmpDir();
  for (let i = 0; i < VAULT_MAX_FILES + 3; i++) writeFileSync(join(many, `f${String(i).padStart(5, '0')}.md`), `# N${i}\n`);
  const g2 = mkGraph().g;
  const r2 = importVault(g2, many);
  assert.equal(r2.files, VAULT_MAX_FILES);
  assert.equal(g2.stats(HUMAN).nodes, VAULT_MAX_FILES);
  assert.ok(r2.skipped.some((s) => s.path === '*' && /5000/.test(s.reason)));
});

test('import rejects a path that is not a directory', () => {
  const { g } = mkGraph();
  const f = join(tmpDir(), 'file.md');
  writeFileSync(f, '# x');
  for (const p of [f, join(tmpDir(), 'does-not-exist')]) {
    assert.throws(() => importVault(g, p), (e: unknown) => e instanceof KgError && e.code === 'invalid');
  }
});

test('a stored vault round trip keeps untrusted flags from sources', () => {
  const src = mkGraph();
  src.g.upsertNode(ALPHA, { title: 'Web fact', body: 'b', sources: [{ ref: 'https://evil.test' }], untrusted: true });
  const vault = tmpDir();
  exportVault(src.g, HUMAN, vault);
  const dst = mkGraph();
  importVault(dst.g, vault);
  const n = dst.g.findByTitle(HUMAN, 'Web fact')[0]!;
  assert.equal(n.sources!.find((s) => s.ref === 'https://evil.test')!.untrusted, true);
  assert.deepEqual(dst.g.lint(HUMAN).untrustedWithoutReview, [n.id]);
});
