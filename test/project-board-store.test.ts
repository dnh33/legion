/** Project board store: owner writes, caps, order, storage and bot rules (controls C3, C4, C5, C7, C13, C14, C15). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardError, BoardStore } from '../src/core/projects/board/store.js';
import type { ProjectRef } from '../src/core/projects/board/store.js';
import { BOARD_LIMITS } from '../src/shared/board.js';

const PID = 'proj_aaaaaaaaaaaa';
const P: ProjectRef = { id: PID, members: ['scout', 'zealot'], status: 'active' };
const dir = () => mkdtempSync(join(tmpdir(), 'legion-board-'));
const code = (fn: () => unknown, status: number, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof BoardError && e.status === status && (!re || re.test(e.message)), `expected BoardError ${status}`);
const run = { tainted: false };

test('C3 owner create / edit / delete with validation; a bad field leaves the item untouched', () => {
  const s = new BoardStore(dir());
  const i = s.create(P, { title: '  Fix   the\nlogin ', description: 'x'.repeat(5000), priority: 'high', labels: ['Bug', 'ui', 'bug'], due: '2026-12-31', assignee: { kind: 'agent', id: 'scout' } });
  assert.equal(i.title, 'Fix the login'); assert.equal(i.description.length, BOARD_LIMITS.descriptionChars, 'description is clipped, not refused');
  assert.deepEqual(i.labels, ['bug', 'ui']); assert.equal(i.status, 'backlog'); assert.equal(i.trust, 'human'); assert.deepEqual(i.createdBy, { kind: 'owner' });
  code(() => s.create(P, { title: '' }), 400); code(() => s.create(P, { title: 'x'.repeat(121) }), 400);
  code(() => s.create(P, { title: 't', due: '2026-02-30' }), 400, /real date/); code(() => s.create(P, { title: 't', due: 'tomorrow' }), 400);
  code(() => s.create(P, { title: 't', priority: 'urgent' }), 400); code(() => s.create(P, { title: 't', status: 'wip' }), 400);
  code(() => s.create(P, { title: 't', labels: ['a', 'b', 'c', 'd', 'e', 'f'] }), 400, /at most 5/); code(() => s.create(P, { title: 't', labels: ['<b>'] }), 400);
  code(() => s.create(P, { title: 't', assignee: { kind: 'agent', id: 'ghost' } }), 400, /not a member/);
  const before = JSON.stringify(s.get(PID, i.id));
  code(() => s.patch(P, i.id, { title: 'ok', priority: 'nope' }), 400);
  assert.equal(JSON.stringify(s.get(PID, i.id)), before, 'nothing applied when one field is bad');
  const e = s.patch(P, i.id, { title: 'New', status: 'done', assignee: null, due: null });
  assert.equal(e.title, 'New'); assert.equal(e.status, 'done'); assert.equal(e.assignee, null); assert.equal(e.due, undefined);
  assert.ok(e.activity.some((a) => a.kind === 'status' && /backlog → done/.test(a.text)), 'the trail records who/what');
  s.remove(P, i.id); assert.equal(s.get(PID, i.id), undefined);
  code(() => s.patch(P, 'wi_000000000000', { title: 'x' }), 404);
  code(() => s.view({ id: '../x', members: [], status: 'active' }), 404);
});

test('C3 caps: items per project and Inbox size', () => {
  const s = new BoardStore(dir());
  for (let n = 0; n < BOARD_LIMITS.itemsPerProject; n++) s.create(P, { title: `t${n}` });
  code(() => s.create(P, { title: 'one more' }), 409, /at most 200/);
  const P2: ProjectRef = { ...P, members: ["scout", "zealot"] };
  const clock = { now: 0 };
  const s4 = new BoardStore(dir(), () => clock.now);
  for (let k = 0; k < BOARD_LIMITS.inboxPerAgent; k++) { clock.now = k * 11 * 60_000; s4.propose(P2, "scout", { title: `p${k}` }, run); }
  clock.now = 99 * 60_000;
  code(() => s4.propose(P2, "scout", { title: "p-extra" }, run), 409, /already have 8/);
});

test('C15 order stays dense per column across create, move, status change, delete', () => {
  const s = new BoardStore(dir());
  const [a, b, c] = ['a', 'b', 'c'].map((t) => s.create(P, { title: t }));
  const names = (st: string) => s.view(P).items.filter((i) => i.status === st).map((i) => `${i.title}:${i.order}`);
  assert.deepEqual(names('backlog'), ['a:0', 'b:1', 'c:2']);
  s.move(P, c!.id, 'backlog', 0); assert.deepEqual(names('backlog'), ['c:0', 'a:1', 'b:2']);
  s.move(P, a!.id, 'doing', 0); assert.deepEqual(names('backlog'), ['c:0', 'b:1']); assert.deepEqual(names('doing'), ['a:0']);
  s.move(P, b!.id, 'doing', 0); assert.deepEqual(names('doing'), ['b:0', 'a:1']);
  s.move(P, a!.id, 'doing', 99); assert.deepEqual(names('doing'), ['b:0', 'a:1'], 'index is clamped');
  s.patch(P, b!.id, { status: 'review' }); assert.deepEqual(names('doing'), ['a:0']); assert.deepEqual(names('review'), ['b:0']);
  s.remove(P, c!.id); assert.deepEqual(names('backlog'), []);
  code(() => s.move(P, a!.id, 'doing', 1.5), 400); code(() => s.move(P, a!.id, 'nowhere', 0), 400);
});

test('C14 an archived project board is read-only for every write path', () => {
  const s = new BoardStore(dir());
  const i = s.create(P, { title: 'x', assignee: { kind: 'agent', id: 'scout' } });
  const A: ProjectRef = { ...P, status: 'archived' };
  code(() => s.create(A, { title: 'y' }), 409, /archived/); code(() => s.patch(A, i.id, { title: 'y' }), 409); code(() => s.move(A, i.id, 'doing', 0), 409);
  code(() => s.remove(A, i.id), 409); code(() => s.propose(A, 'scout', { title: 'z' }, run), 409);
  code(() => s.botUpdate(A, 'scout', i.id, { note: 'n' }, run), 409); code(() => s.beginRun(A, i.id, 't1'), 409);
  assert.equal(s.view(A).items.length, 1, 'reading still works'); assert.equal(s.view(A).archived, true);
});

test('C4 a bot proposal is untrusted, sits in the Inbox, is never live, and tainted runs are marked', () => {
  const s = new BoardStore(dir(), () => 0);
  const i = s.propose(P, 'scout', { title: 'Add tests', description: 'because', suggestedAssignee: 'zealot' }, { tainted: true });
  assert.equal(i.trust, 'untrusted'); assert.ok(i.proposal); assert.equal(i.assignee, null);
  assert.deepEqual(i.createdBy, { kind: 'agent', id: 'scout', tainted: true });
  const v = s.view(P); assert.equal(v.items.length, 0, 'not on the board'); assert.equal(v.inbox.length, 1);
  code(() => s.move(P, i.id, 'doing', 0), 409, /Accept/); code(() => s.patch(P, i.id, { status: 'doing' }), 409);
  code(() => s.propose(P, 'outsider', { title: 'x' }, run), 403);
  code(() => s.propose(P, 'scout', { title: 'x', suggestedAssignee: 'ghost' }, run), 400);
  code(() => s.propose(P, 'scout', { title: 'add TESTS' }, run), 409, /already proposed/);
  const a = s.accept(P, i.id, { assignee: { kind: 'agent', id: 'zealot' } });
  assert.equal(a.proposal, undefined); assert.equal(a.status, 'backlog'); assert.equal(a.trust, 'untrusted', 'accepting does not make bot text trusted');
  assert.equal(s.patch(P, i.id, { trust: 'human' }).trust, 'human');
  code(() => s.patch(P, i.id, { trust: 'untrusted' }), 400);
  code(() => s.accept(P, i.id), 409, /not waiting/);
  const r = s.propose(P, 'scout', { title: 'Reject me' }, run); s.reject(P, r.id); assert.equal(s.get(PID, r.id), undefined);
});

test('C4 proposals: secrets refused or redacted; rate limit per agent and window', () => {
  const clock = { now: 0 };
  const s = new BoardStore(dir(), () => clock.now);
  code(() => s.propose(P, 'scout', { title: 'key', description: 'private key: ' + 'ab'.repeat(32) }, run), 400, /secret/);
  const red = s.propose(P, 'scout', { title: 'tok', description: 'use sk-ant-api03-' + 'x'.repeat(40) }, run);
  assert.ok(!red.description.includes('sk-ant-api03-xxxx'), 'credential shapes are redacted');
  for (let k = 0; k < BOARD_LIMITS.proposalsPerWindow - 1; k++) s.propose(P, 'scout', { title: `n${k}` }, run);
  code(() => s.propose(P, 'scout', { title: 'too many' }, run), 429, /at most 5/);
  s.propose(P, 'zealot', { title: 'other agent is separate' }, run);
  clock.now += BOARD_LIMITS.proposalWindowMs + 1;
  s.propose(P, 'scout', { title: 'after the window' }, run);
});

test('C5 agent edits: any member edits any open item; never done; owner-assigned items take notes only; text edits clear trust; a bad field changes nothing', () => {
  const s = new BoardStore(dir(), () => 0);
  const mine = s.create(P, { title: 'mine', assignee: { kind: 'agent', id: 'scout' }, description: 'orig' });
  const theirs = s.create(P, { title: 'theirs', assignee: { kind: 'agent', id: 'zealot' } });
  const free = s.create(P, { title: 'free' });
  const owners = s.create(P, { title: 'owner task', assignee: { kind: 'owner' } });
  const u = s.botUpdate(P, 'scout', mine.id, { status: 'doing', note: 'started', priority: 'high', labels: ['x'], due: '2026-12-01' }, { taskId: 'task_1', tainted: false, roomId: 'room_0123456789ab' });
  assert.equal(u.status, 'doing'); assert.deepEqual(u.taskIds, ['task_1']); assert.deepEqual(u.roomIds, ['room_0123456789ab']);
  assert.equal(u.priority, 'high'); assert.deepEqual(u.labels, ['x']); assert.equal(u.due, '2026-12-01');
  assert.equal(u.trust, 'human', 'a status change is not a text edit');
  assert.ok(u.activity.some((a) => a.kind === 'note' && a.text === 'started' && a.by.kind === 'agent'));
  // another member's item, and a free one: claim, retitle, move
  const t = s.botUpdate(P, 'scout', theirs.id, { title: 'theirs, renamed', assignee: { kind: 'agent', id: 'scout' }, status: 'review' }, run);
  assert.equal(t.title, 'theirs, renamed'); assert.equal(t.trust, 'untrusted', 'agent text: not reviewed by the owner'); assert.deepEqual(t.assignee, { kind: 'agent', id: 'scout' });
  assert.equal(s.botUpdate(P, 'zealot', free.id, { description: 'new text', status: 'backlog', index: 0 }, run).description, 'new text');
  // done and owner-assigned limits
  for (const bad of ['done', 'wip']) code(() => s.botUpdate(P, 'scout', mine.id, { status: bad }, run), bad === 'done' ? 403 : 400);
  code(() => s.botUpdate(P, 'scout', mine.id, { assignee: { kind: 'owner' } }, run), 403, /owner/);
  code(() => s.botUpdate(P, 'scout', owners.id, { status: 'doing' }, run), 403, /assigned to the owner/);
  code(() => s.botUpdate(P, 'scout', owners.id, { title: 'mine now' }, run), 403);
  assert.equal(s.botUpdate(P, 'scout', owners.id, { note: 'fyi' }, run).activity.at(-1)!.text, 'fyi', 'a note on an owner item is fine');
  code(() => s.botUpdate(P, 'scout', mine.id, {}, run), 400); code(() => s.botUpdate(P, 'outsider', mine.id, { note: 'x' }, run), 403);
  const before = JSON.stringify(s.get(PID, mine.id));
  code(() => s.botUpdate(P, 'scout', mine.id, { title: 'ok', priority: 'urgent' }, run), 400);
  assert.equal(JSON.stringify(s.get(PID, mine.id)), before, 'nothing applied when one field is bad');
  const prop = s.propose(P, 'scout', { title: 'p' }, run);
  code(() => s.botUpdate(P, 'scout', prop.id, { note: 'x' }, run), 404, undefined);
  s.patch(P, mine.id, { status: 'done' });
  code(() => s.botUpdate(P, 'scout', mine.id, { status: 'doing' }, run), 409, /closed/);
  s.patch(P, mine.id, { status: 'review' });
  assert.equal(s.botUpdate(P, 'scout', mine.id, { note: 'n'.repeat(900) }, { tainted: true }).activity.at(-1)!.text.length, BOARD_LIMITS.noteChars);
  assert.deepEqual(s.get(PID, mine.id)!.activity.at(-1)!.by, { kind: 'agent', id: 'scout', tainted: true });
  // an item of another project is not found
  const other: ProjectRef = { id: 'proj_bbbbbbbbbbbb', members: ['scout'], status: 'active' };
  code(() => s.botUpdate(other, 'scout', mine.id, { note: 'x' }, run), 404);
});

test('C5 a tainted run may edit and move but not assign; a trusted owner item keeps trust through a status move', () => {
  const s = new BoardStore(dir(), () => 0);
  const i = s.create(P, { title: 'x' });
  code(() => s.botUpdate(P, 'scout', i.id, { assignee: { kind: 'agent', id: 'scout' } }, { tainted: true }), 403, /outside content/);
  assert.equal(s.botUpdate(P, 'scout', i.id, { status: 'doing' }, { tainted: true }).trust, 'human');
});

test('C5 agent create: live, untrusted, no done, no owner assignee, tainted cannot assign, rate limited', () => {
  const clock = { now: 0 };
  const s = new BoardStore(dir(), () => clock.now);
  const i = s.botCreate(P, 'scout', { title: 'New', description: 'd', status: 'doing', assignee: { kind: 'agent', id: 'zealot' }, due: '2026-12-01', labels: ['a'] }, run);
  assert.equal(i.proposal, undefined); assert.equal(i.trust, 'untrusted'); assert.equal(i.status, 'doing'); assert.deepEqual(i.createdBy, { kind: 'agent', id: 'scout' });
  assert.equal(s.view(P).items.length, 1);
  code(() => s.botCreate(P, 'scout', { title: 'x', status: 'done' }, run), 403); code(() => s.botCreate(P, 'scout', { title: 'x', assignee: { kind: 'owner' } }, run), 403);
  code(() => s.botCreate(P, 'scout', { title: 'x', assignee: { kind: 'agent', id: 'zealot' } }, { tainted: true }), 403);
  code(() => s.botCreate(P, 'outsider', { title: 'x' }, run), 403); code(() => s.botCreate(P, 'scout', { title: 'k', description: '-----BEGIN PRIVATE KEY-----' }, run), 400);
  assert.equal(s.botCreate(P, 'scout', { title: 'tainted ok' }, { tainted: true }).createdBy.kind, 'agent');
  for (let k = 0; k < BOARD_LIMITS.botCreatesPerWindow - 2; k++) s.botCreate(P, 'scout', { title: `c${k}` }, run);
  code(() => s.botCreate(P, 'scout', { title: 'over' }, run), 429, /at most 10/);
  clock.now += BOARD_LIMITS.proposalWindowMs + 1;
  s.botCreate(P, 'scout', { title: 'after the window' }, run);
});

test('C6 delete: only the owner-chosen leader, never tainted, never done or owner items; the check counts requests; a removed leader loses it', () => {
  const clock = { now: 0 };
  const s = new BoardStore(dir(), () => clock.now);
  const a = s.create(P, { title: 'a' }); const b = s.create(P, { title: 'b' }); const d = s.create(P, { title: 'done', status: 'done' }); const o = s.create(P, { title: 'o', assignee: { kind: 'owner' } });
  code(() => s.checkBotDelete(P, 'scout', a.id, run), 403, /leader/);
  code(() => s.setLeader(P, 'ghost'), 400); assert.equal(s.leaderOf(P), undefined);
  s.setLeader(P, 'scout'); assert.equal(s.leaderOf(P), 'scout'); assert.equal(s.view(P).leader, 'scout');
  code(() => s.checkBotDelete(P, 'zealot', a.id, run), 403, /leader/);
  code(() => s.checkBotDelete(P, 'scout', a.id, { tainted: true }), 403, /outside content/);
  code(() => s.checkBotDelete(P, 'scout', d.id, run), 403, /Done/); code(() => s.checkBotDelete(P, 'scout', o.id, run), 403, /owner/);
  code(() => s.checkBotDelete(P, 'scout', 'wi_000000000000', run), 404);
  s.botDelete(P, 'scout', a.id, run);
  assert.equal(s.get(PID, a.id), undefined); assert.deepEqual(s.view(P).items.filter((i) => i.status === 'backlog').map((i) => `${i.title}:${i.order}`), ['b:0', 'o:1']);
  for (let k = 0; k < BOARD_LIMITS.botDeletesPerWindow; k++) s.checkBotDelete(P, 'scout', b.id, run, true);
  code(() => s.checkBotDelete(P, 'scout', b.id, run, true), 429, /At most 3/);
  // the leader is no longer a member: the power goes with the membership
  assert.equal(s.leaderOf({ ...P, members: ['zealot'] }), undefined);
  code(() => s.checkBotDelete({ ...P, members: ['zealot'] }, 'scout', b.id, run), 403);
  s.setLeader(P, null); assert.equal(s.leaderOf(P), undefined);
});

test('C13 the leader setting survives reload and compaction', () => {
  const d = dir();
  const s = new BoardStore(d);
  s.create(P, { title: 'x' }); s.setLeader(P, 'zealot');
  assert.equal(new BoardStore(d).leaderOf(P), 'zealot');
  s.compact((s as any).board(PID));
  assert.equal(new BoardStore(d).leaderOf(P), 'zealot');
  s.setLeader(P, null);
  assert.equal(new BoardStore(d).leaderOf(P), undefined);
});

test('runs: beginRun links and moves to doing; endRun goes to review or blocked, never done, and respects an owner move', () => {
  const s = new BoardStore(dir());
  const i = s.create(P, { title: 'run me', assignee: { kind: 'agent', id: 'scout' } });
  s.beginRun(P, i.id, 'task_1');
  assert.equal(s.get(PID, i.id)!.status, 'doing'); assert.equal(s.get(PID, i.id)!.activeRun, 'task_1');
  const r = s.endRun(PID, 'task_1', { status: 'done', isError: false, text: 'all good ' + 'x'.repeat(3000), tainted: true })!;
  assert.equal(r.status, 'review'); assert.equal(r.activeRun, undefined); assert.equal(r.lastRun!.tainted, true); assert.equal(r.lastRun!.preview.length, BOARD_LIMITS.previewChars);
  assert.equal(s.endRun(PID, 'task_1', { status: 'done', isError: false, tainted: false }), undefined, 'a second end finds nothing');
  s.beginRun(P, i.id, 'task_2');
  assert.equal(s.endRun(PID, 'task_2', { status: 'error', isError: true, text: 'boom', tainted: false })!.status, 'blocked');
  s.beginRun(P, i.id, 'task_3'); s.patch(P, i.id, { status: 'done' });
  const k = s.endRun(PID, 'task_3', { status: 'done', isError: false, text: 'late', tainted: false })!;
  assert.equal(k.status, 'done', 'the owner closed it; the run end does not move it'); assert.equal(k.lastRun!.taskId, 'task_3');
  for (const it of s.view(P).items) for (const a of it.activity) if (a.kind === 'status') assert.ok(!/→ done/.test(a.text) || a.by.kind === 'owner', 'only the owner ever writes "→ done"');
});

test('C13 storage: reload, torn last line, unknown fields and v2 lines survive, corrupt file is backed up, compaction is atomic', () => {
  const d = dir();
  const s = new BoardStore(d);
  const a = s.create(P, { title: 'a' }); const b = s.create(P, { title: 'b' }); s.move(P, b.id, 'backlog', 0);
  const file = join(d, `${PID}.jsonl`);
  // a later build's additions
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = lines.at(-1);
  writeFileSync(file, lines.map((l) => (l.item?.id === last.item.id ? JSON.stringify({ ...l, item: { ...l.item, futureField: { x: 1 } } }) : JSON.stringify(l))).join('\n') + '\n' + JSON.stringify({ v: 2, kind: 'something-new', data: 1 }) + '\n' + '{"v":1,"kind":"item","at":"x","item":{"id":"wi_0000');
  const s2 = new BoardStore(d);
  const v = s2.view(P);
  assert.deepEqual(v.items.map((i) => i.title), ['b', 'a'], 'order and content survive a reload, the torn last line is skipped');
  s2.patch(P, last.item.id, { priority: 'high' });
  s2.compact((s2 as any).board(PID));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('futureField'), 'unknown item fields are written back');
  assert.ok(text.includes('"something-new"'), 'a later build\'s line is kept');
  assert.ok(!existsSync(file + '.tmp'), 'no temp file is left');
  assert.equal(text.trim().split('\n').length, 3, 'one snapshot per item + the foreign line');
  assert.equal(new BoardStore(d).view(P).items.length, 2);
  // corrupt: too large
  writeFileSync(file, 'x'.repeat(BOARD_LIMITS.fileBytes + 10));
  const s3 = new BoardStore(d);
  assert.equal(s3.view(P).items.length, 0);
  assert.ok(readdirSync(d).some((f) => f.includes('.corrupt-')), 'the damaged file is kept aside');
  assert.ok(a.id);
});

test('C13 damaged item values never widen trust or break the board', () => {
  const d = dir();
  writeFileSync(join(d, `${PID}.jsonl`), [
    JSON.stringify({ v: 1, kind: 'item', at: 'x', item: { id: 'wi_aaaaaaaaaaaa', title: 'ok', trust: 'something', status: 'zzz', priority: 9, labels: 'no', taskIds: 'no', assignee: 7, activity: 'no', order: 'NaN' } }),
    JSON.stringify({ v: 1, kind: 'item', at: 'x', item: { id: 'bad id', title: 'skipped' } }), 'not json', '',
  ].join('\n'));
  const i = new BoardStore(d).view(P).items[0]!;
  assert.equal(i.trust, 'untrusted'); assert.equal(i.status, 'backlog'); assert.equal(i.priority, 'normal'); assert.deepEqual(i.labels, []); assert.equal(i.assignee, null);
  assert.equal(new BoardStore(d).view(P).items.length, 1);
});

test('C13 many writes compact the log on their own', () => {
  const d = dir();
  const s = new BoardStore(d);
  const i = s.create(P, { title: 'x' });
  for (let k = 0; k < 400; k++) s.patch(P, i.id, { description: `v${k}` });
  const n = readFileSync(join(d, `${PID}.jsonl`), 'utf8').trim().split('\n').length;
  assert.ok(n < 250, `log was compacted (${n} lines)`);
  assert.equal(new BoardStore(d).get(PID, i.id)!.description, 'v399');
  appendFileSync(join(d, `${PID}.jsonl`), '');
});

test('C3 the Inbox holds at most 30 proposals per project', () => {
  const clock = { now: 0 };
  const members = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const PX: ProjectRef = { id: PID, members, status: 'active' };
  const s = new BoardStore(dir(), () => clock.now);
  let n = 0;
  for (const m of members) for (let k = 0; k < 5; k++, n++) { clock.now = n * 11 * 60_000; s.propose(PX, m, { title: `${m}-${k}` }, run); }
  assert.equal(s.view(PX).inbox.length, BOARD_LIMITS.inboxPerProject);
  clock.now += 99 * 60_000;
  code(() => s.propose(PX, 'm1', { title: 'one more' }, run), 409, /already holds 30/);
});
