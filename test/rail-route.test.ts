import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askTarget, clearAskRequest, clearInboxRequest, getAskRequest, getInboxRequest, inboxFocusPlan, latestChat, noteTaskSelected, noteViewSet,
  BOARD_WAIT_MS, canTakeFocus, failBoardLoad, markBoardSettled, navigationCount, noteNavigation, withoutNavigation, pickAskCard, proposalFocusPlan, proposalsForThread, REQUEST_TTL_MS, requestAsk, requestInbox,
} from '../ui/src/projects/railRoute.js';

const T = (id: string, agentId: string, projectId: string | undefined, updatedAt: string, archived = false) => ({ id, agentId, projectId, updatedAt, archived });
const tasks = [
  T('t-old', 'forge', 'p2', '2026-10-14T08:00:00Z'),
  T('t-new', 'forge', 'p2', '2026-10-14T11:00:00Z'),
  T('t-arch', 'forge', 'p2', '2026-10-14T12:00:00Z', true),
  T('t-other-agent', 'scout', 'p2', '2026-10-14T13:00:00Z'),
  T('t-other-proj', 'forge', 'p1', '2026-10-14T14:00:00Z'),
];

test('latestChat: the agent\'s newest unarchived chat in that project', () => {
  assert.equal(latestChat('forge', 'p2', tasks)?.id, 't-new');
  assert.equal(latestChat('forge', 'p9', tasks), undefined);
  assert.equal(latestChat('nobody', 'p2', tasks), undefined);
});

test('a proposal opens the proposing agent\'s newest chat in that project, naming the card', () => {
  assert.deepEqual(askTarget({ kind: 'proposal', id: 'wi1', agentId: 'forge', projectId: 'p2' }, tasks), { kind: 'thread', taskId: 't-new', askId: 'wi1', proposalProject: 'p2' });
});
test('a proposal from an agent with no chat in that project opens a new chat for it there', () => {
  assert.deepEqual(askTarget({ kind: 'proposal', id: 'wi1', agentId: 'forge', projectId: 'p9' }, tasks), { kind: 'newChat', agentId: 'forge', projectId: 'p9', askId: 'wi1', proposalProject: 'p9' });
});
test('a proposal with no agent (or no project) cannot open a chat: the Inbox entry, else nothing', () => {
  assert.deepEqual(askTarget({ kind: 'proposal', id: 'wi1', agentId: '', projectId: 'p2' }, tasks), { kind: 'inbox', projectId: 'p2', itemId: 'wi1' });
  assert.deepEqual(askTarget({ kind: 'proposal', id: 'wi1', agentId: 'forge', projectId: null }, tasks), { kind: 'none' });
});
test('an approval or question opens the thread that holds it and names the card', () => {
  assert.deepEqual(askTarget({ kind: 'approval', id: 'ap1', taskId: 't9', agentId: 'forge', projectId: 'p2' }, tasks), { kind: 'thread', taskId: 't9', askId: 'ap1' });
  assert.deepEqual(askTarget({ kind: 'parked', id: 'k1', taskId: 't9', agentId: 'forge', projectId: null }, tasks), { kind: 'thread', taskId: 't9', askId: 'k1' });
});
test('a row with no task falls back to the project, else nothing', () => {
  assert.deepEqual(askTarget({ kind: 'question', id: 'q1', agentId: 'forge', projectId: 'p2' }, tasks), { kind: 'project', projectId: 'p2' });
  assert.deepEqual(askTarget({ kind: 'question', id: 'q1', agentId: 'forge', projectId: null }, tasks), { kind: 'none' });
});

test('pickAskCard prefers the named card, then the first approval, then the first question', () => {
  const ap = [{ id: 'a1', taskId: 't1' }, { id: 'a2', taskId: 't1' }, { id: 'a3', taskId: 't2' }];
  const qs = [{ id: 'q1', taskId: 't1' }];
  assert.deepEqual(pickAskCard('t1', 'a2', ap, qs), { kind: 'approval', id: 'a2' });
  assert.deepEqual(pickAskCard('t1', 'q1', ap, qs), { kind: 'question', id: 'q1' });
  assert.deepEqual(pickAskCard('t1', 'gone', ap, qs), { kind: 'approval', id: 'a1' });
  assert.equal(pickAskCard('t9', 'a1', ap, qs), null);
});

test('inboxFocusPlan: other project ignored, unloaded board waits, found shows, loaded without it is gone', () => {
  const req = { projectId: 'p2', itemId: 'wi1' };
  assert.equal(inboxFocusPlan(null, 'p2', [], true), 'ignore');
  assert.equal(inboxFocusPlan(req, 'p3', [{ id: 'wi1' }], true), 'ignore');
  assert.equal(inboxFocusPlan(req, 'p2', [], false), 'wait');
  assert.equal(inboxFocusPlan(req, 'p2', [{ id: 'wi1' }], true), 'show');
  assert.equal(inboxFocusPlan(req, 'p2', [{ id: 'other' }], true), 'gone');
});

const prop = (id: string, by: string, projectId: string, at: string) => ({ id, projectId, createdAt: at, createdBy: by ? { kind: 'agent', id: by } : { kind: 'owner' } });
test('proposalsForThread: cards only in the chat the click opens (the agent\'s newest in the project), oldest first', () => {
  const list = [prop('b', 'forge', 'p2', '2026-10-14T12:00:00Z'), prop('a', 'forge', 'p2', '2026-10-14T10:00:00Z'), prop('x', 'scout', 'p2', '2026-10-14T09:00:00Z'), prop('o', '', 'p2', '2026-10-14T08:00:00Z'), prop('z', 'forge', 'p1', '2026-10-14T07:00:00Z')];
  const none = new Set<string>();
  assert.deepEqual(proposalsForThread('forge', 't-new', tasks, list, none).map((p) => p.id), ['a', 'b'], 'p2 cards in the newest p2 chat');
  assert.deepEqual(proposalsForThread('forge', 't-old', tasks, list, none).map((p) => p.id), [], 'not in an older chat of the same project');
  assert.deepEqual(proposalsForThread('forge', 't-other-proj', tasks, list, none).map((p) => p.id), ['z'], 'p1 card in the newest p1 chat');
  assert.deepEqual(proposalsForThread('forge', null, tasks, [prop('n', 'forge', 'p9', '2026-10-14T06:00:00Z')], none).map((p) => p.id), ['n'], 'the new-chat view shows proposals of projects where the agent has no chat');
  assert.deepEqual(proposalsForThread('forge', null, tasks, list, none).map((p) => p.id), [], 'no new-chat card while a chat exists');
  assert.deepEqual(proposalsForThread('forge', 't-new', tasks, list, new Set(['p2'])).map((p) => p.id), [], 'proposals of an archived project are left out');
});

test('a focus request older than the TTL is ignored', () => {
  clearAskRequest(); clearInboxRequest();
  requestAsk('t1', 'a1', 1000);
  assert.deepEqual(getAskRequest(1000 + REQUEST_TTL_MS - 1), { taskId: 't1', askId: 'a1', at: 1000 });
  assert.equal(getAskRequest(1000 + REQUEST_TTL_MS + 1), null);
  requestInbox('p1', 'wi1', 5000);
  assert.deepEqual(getInboxRequest(5001), { projectId: 'p1', itemId: 'wi1', at: 5000 });
  assert.ok(getInboxRequest(5000 + REQUEST_TTL_MS + 1), 'an Inbox request waits for its board, not a flat 3 s');
  assert.equal(REQUEST_TTL_MS, 3000);
});
test('opening a different task drops a pending card request; the same task keeps it', () => {
  clearAskRequest();
  requestAsk('t1', 'a1', 1000);
  noteTaskSelected('t1');
  assert.ok(getAskRequest(1001));
  noteTaskSelected('t2');
  assert.equal(getAskRequest(1001), null);
  requestAsk(null, 'wi1', 1000);
  noteTaskSelected(null);
  assert.ok(getAskRequest(1001), 'the new-chat view keeps a request made for it');
  noteTaskSelected('t3');
  assert.equal(getAskRequest(1001), null);
});
test('leaving the chat or the project page drops the matching request', () => {
  clearAskRequest(); clearInboxRequest();
  requestAsk('t1', 'a1', 1000); requestInbox('p1', 'wi1', 1000);
  noteViewSet('project');
  assert.ok(getInboxRequest(1001), 'the project page keeps the Inbox request');
  assert.equal(getAskRequest(1001), null, 'a card request is for the chat');
  requestAsk('t1', 'a1', 1000);
  noteViewSet('chat');
  assert.ok(getAskRequest(1001));
  assert.equal(getInboxRequest(1001), null, 'an Inbox request is for the project page');
  noteViewSet('graph');
  assert.equal(getAskRequest(1001), null);
});

test('proposalFocusPlan: a proposal request waits for the board, shows its card, or reports it gone', () => {
  const req = { taskId: 't1', askId: 'wi1', at: 1, projectId: 'p2' };
  assert.equal(proposalFocusPlan(null, 't1', ['wi1'], ['wi1'], true), 'ignore');
  assert.equal(proposalFocusPlan({ taskId: 't1', askId: 'wi1', at: 1 }, 't1', ['wi1'], ['wi1'], true), 'ignore', 'not a proposal request');
  assert.equal(proposalFocusPlan(req, 't2', ['wi1'], ['wi1'], true), 'ignore', 'another chat');
  assert.equal(proposalFocusPlan(req, 't1', ['wi1'], ['wi1'], true), 'show');
  assert.equal(proposalFocusPlan(req, 't1', [], [], false), 'wait', 'cold start: the board has not loaded yet');
  assert.equal(proposalFocusPlan(req, 't1', [], [], true), 'gone', 'loaded and it is not there');
  assert.equal(proposalFocusPlan(req, 't1', [], ['wi1'], true), 'ignore', 'it exists but this chat does not hold its card');
});
test('requestAsk can carry the proposal project', () => {
  clearAskRequest();
  requestAsk('t1', 'wi1', 1000, 'p2');
  assert.deepEqual(getAskRequest(1001), { taskId: 't1', askId: 'wi1', at: 1000, projectId: 'p2' });
  clearAskRequest();
});
test('canTakeFocus: never from a text field', () => {
  assert.equal(canTakeFocus(null), true);
  assert.equal(canTakeFocus({ tagName: 'BUTTON' }), true);
  assert.equal(canTakeFocus({ tagName: 'DIV', isContentEditable: false }), true);
  assert.equal(canTakeFocus({ tagName: 'INPUT' }), false);
  assert.equal(canTakeFocus({ tagName: 'TEXTAREA' }), false);
  assert.equal(canTakeFocus({ tagName: 'SELECT' }), false);
  assert.equal(canTakeFocus({ tagName: 'DIV', isContentEditable: true }), false);
});

test('a proposal request lives until its board load settles, then the 3 s starts; approval and question requests keep the flat 3 s', () => {
  clearAskRequest(); clearInboxRequest();
  requestAsk('t1', 'a1', 1000);
  assert.equal(getAskRequest(1000 + REQUEST_TTL_MS + 1), null, 'no project: flat TTL');
  requestAsk('t1', 'wi1', 1000, 'p2');
  assert.ok(getAskRequest(1000 + 10_000), 'a slow board load does not kill it');
  assert.equal(getAskRequest(1000 + BOARD_WAIT_MS + 1), null, 'but it is not immortal');
  markBoardSettled(1000, 12_000);
  assert.equal(getAskRequest(12_000)?.boardAt, 12_000);
  assert.ok(getAskRequest(12_000 + REQUEST_TTL_MS - 1));
  assert.equal(getAskRequest(12_000 + REQUEST_TTL_MS + 1), null, 'the 3 s starts when the load finished');
  clearAskRequest();
});
test('markBoardSettled only touches the request it was started for', () => {
  clearAskRequest(); clearInboxRequest();
  requestAsk('t1', 'wi1', 2000, 'p2');
  requestInbox('p3', 'wi2', 2000);
  markBoardSettled(1999, 2500);
  assert.equal(getAskRequest(2501)?.boardAt, undefined);
  assert.equal(getInboxRequest(2501)?.boardAt, undefined);
  markBoardSettled(2000, 2500);
  assert.equal(getAskRequest(2501)?.boardAt, 2500);
  assert.equal(getInboxRequest(2501)?.boardAt, 2500);
  clearAskRequest(); clearInboxRequest();
});
test('failBoardLoad clears the request it was started for and says so; a newer request is left alone', () => {
  clearAskRequest(); clearInboxRequest();
  requestAsk('t1', 'wi1', 3000, 'p2');
  assert.equal(failBoardLoad(2999, 3500), false);
  assert.ok(getAskRequest(3001));
  assert.equal(failBoardLoad(3000, 3500), true);
  assert.equal(getAskRequest(3001), null);
  requestInbox('p1', 'wi1', 4000);
  assert.equal(failBoardLoad(4000, 4500), true);
  assert.equal(getInboxRequest(4001), null);
});

test('round 4: a late load cannot revive an expired request (no settle, no late toast)', () => {
  requestAsk('t1', 'a1', 1000, 'p1');
  const late = 1000 + BOARD_WAIT_MS + 1;
  markBoardSettled(1000, late);
  assert.equal(getAskRequest(late), null, 'still expired after a late settle');
  requestAsk('t1', 'a1', 1000, 'p1');
  assert.equal(failBoardLoad(1000, late), false, 'an expired request is not announced as failed');
  requestInbox('p1', 'wi1', 1000);
  markBoardSettled(1000, late);
  assert.equal(getInboxRequest(late), null);
  clearAskRequest(); clearInboxRequest();
});
test('round 4: a settle inside the wait window still works', () => {
  requestAsk('t1', 'a1', 1000, 'p1');
  markBoardSettled(1000, 1000 + BOARD_WAIT_MS);
  assert.ok(getAskRequest(1000 + BOARD_WAIT_MS + 100));
  assert.equal(failBoardLoad(1000, 1000 + BOARD_WAIT_MS), true);
  clearAskRequest();
});

test('round 4: navigation counter counts manual moves, not the routing\'s own or the system\'s', () => {
  const before = navigationCount();
  noteNavigation();
  assert.equal(navigationCount(), before + 1);
  withoutNavigation(() => { noteNavigation(); noteNavigation(); });
  assert.equal(navigationCount(), before + 1);
  assert.throws(() => withoutNavigation(() => { throw new Error('x'); }));
  noteNavigation();
  assert.equal(navigationCount(), before + 2, 'the guard is released even when the callback throws');
});
