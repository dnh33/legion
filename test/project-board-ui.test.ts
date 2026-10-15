/** Board UI logic (pure) and accessible names in the sources (controls C15, C16). */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkItem } from '../src/shared/board.js';
import { BoardStore } from '../src/core/projects/board/store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { applyFilters, byColumn, cardLabel, reviewBadge, descCounter, dueState, dueText, keyMove, learnDraft, moveAnnouncement, moveLocal, NO_FILTERS, parseAssignee, priorityMark, readFilters, shouldOfferNote } from '../ui/src/projects/board/boardLogic.js';

const I = (id: string, status: WorkItem['status'], order: number, over: Partial<WorkItem> = {}): WorkItem => ({
  id, projectId: 'p', title: id, description: '', status, assignee: null, priority: 'normal', labels: [], order, createdBy: { kind: 'owner' }, updatedBy: { kind: 'owner' },
  createdAt: '', updatedAt: '', trust: 'human', taskIds: [], roomIds: [], noteIds: [], activity: [], ...over,
});
const names = (items: WorkItem[], s: string) => byColumn(items)[s as 'backlog'].map((i) => `${i.id}:${i.order}`).join(',');

test('C15 the local move gives the same dense order as the server for the same moves', () => {
  const P = { id: 'proj_aaaaaaaaaaaa', members: [] as string[], status: 'active' as const };
  const server = new BoardStore(cleanupTemp('legion-board-ui-'));
  const ids = ['a', 'b', 'c', 'd'].map((t) => server.create(P, { title: t }).id);
  let local = server.view(P).items;
  const steps: Array<[number, 'backlog' | 'doing' | 'review', number]> = [[2, 'backlog', 0], [0, 'doing', 0], [1, 'doing', 0], [3, 'review', 5], [0, 'doing', 9], [2, 'backlog', 1]];
  for (const [who, st, idx] of steps) {
    local = moveLocal(local, ids[who]!, st, idx);
    server.move(P, ids[who]!, st, idx);
    const real = server.view(P).items;
    for (const col of ['backlog', 'doing', 'review', 'done', 'blocked']) assert.equal(names(local, col), names(real, col), `column ${col} after moving ${who} to ${st}@${idx}`);
  }
});

test('keyboard: Alt+arrows change column or order; edges do nothing; non-arrow keys are not moves', () => {
  const items = [I('a', 'backlog', 0), I('b', 'backlog', 1), I('c', 'doing', 0)];
  const b = items[1]!;
  assert.deepEqual(keyMove(items, b, 'ArrowRight'), { status: 'doing', index: 1 });
  assert.deepEqual(keyMove(items, b, 'ArrowUp'), { status: 'backlog', index: 0 });
  assert.equal(keyMove(items, b, 'ArrowDown'), null);
  assert.equal(keyMove(items, b, 'ArrowLeft'), null);
  assert.equal(keyMove(items, I('z', 'blocked', 0), 'ArrowRight'), null);
  assert.equal(keyMove(items, b, 'Enter'), null);
  assert.match(moveAnnouncement('Fix it', 'review', 0, 3), /Fix it moved to Review, position 1 of 3/);
});

test('filters and labels', () => {
  const items = [I('a', 'backlog', 0, { assignee: { kind: 'agent', id: 'scout' }, priority: 'high', labels: ['bug'] }), I('b', 'doing', 0, { assignee: { kind: 'owner' }, title: 'Write docs' }), I('c', 'done', 0)];
  assert.equal(applyFilters(items, NO_FILTERS).length, 3);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, assignee: 'scout' }).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, assignee: 'agents' }).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, assignee: 'owner' }).map((i) => i.id), ['b']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, assignee: 'none' }).map((i) => i.id), ['c']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, priority: 'high' }).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, label: 'bug' }).map((i) => i.id), ['a']);
  assert.deepEqual(applyFilters(items, { ...NO_FILTERS, q: 'DOCS' }).map((i) => i.id), ['b']);
  assert.deepEqual(readFilters('{"q":"x","status":"nope","assignee":5}'), { ...NO_FILTERS, q: 'x' }, 'a damaged stored filter falls back');
  assert.deepEqual(readFilters('not json'), NO_FILTERS);
});

test('text, not colour alone: priority, due and the card name carry everything', () => {
  assert.match(priorityMark('high'), /High/); assert.match(priorityMark('low'), /Low/); assert.match(priorityMark('normal'), /Normal/);
  assert.equal(dueState('2026-01-01', '2026-01-05'), 'overdue'); assert.equal(dueState('2026-01-05', '2026-01-05'), 'today');
  assert.equal(dueState('2026-01-07', '2026-01-05'), 'soon'); assert.equal(dueState('2026-02-07', '2026-01-05'), 'later'); assert.equal(dueState(undefined), undefined);
  assert.match(dueText('2026-01-01', '2026-01-05'), /Overdue/);
  const l = cardLabel(I('x', 'review', 0, { title: 'Ship', priority: 'high', assignee: { kind: 'agent', id: 'scout' }, due: '2026-01-01', labels: ['ui'], trust: 'untrusted' }), (id) => id.toUpperCase(), '2026-01-05');
  for (const part of ['Ship', 'Review', 'High priority', 'SCOUT', 'Overdue', 'labels ui', 'not reviewed']) assert.ok(l.includes(part), part);
  assert.deepEqual(parseAssignee('agent:scout'), { kind: 'agent', id: 'scout' }); assert.deepEqual(parseAssignee('owner'), { kind: 'owner' }); assert.equal(parseAssignee(''), null);
  assert.equal(descCounter('x'.repeat(2001)).over, true);
});

test('C16 the sources keep the accessible names, the live region, roles and the keyboard path', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'ui', 'src', 'projects', 'board', 'BoardPanel.tsx'), 'utf8');
  for (const needle of ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'role="status" aria-live="polite"', 'aria-label={cardLabel(i, name)}', 'aria-describedby="bd-keys"', 'e.altKey', 'keyMove(', 'aria-label={`Move ${i.title} to`}', 'aria-label={`Accept ${i.title}`}', 'aria-label={`Reject ${i.title}`}', '<caption', 'scope="col"', 'scope="row"', 'aria-label="Activity trail"', 'role="region" aria-label="Save what we learned"', 'Save what we learned', 'shouldOfferNote(', 'Project notes', 'Link a room', 'Unlink room', 'Mark as reviewed', 'Really delete', 'role="search"']) assert.ok(src.includes(needle), `missing: ${needle}`);
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(src), 'item text is rendered as text only');
  const css = readFileSync(join(here, '..', '..', 'ui', 'src', 'projects', 'board', 'board.css'), 'utf8');
  assert.match(css, /focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /@media \(max-width: 760px\)/);
  const view = readFileSync(join(here, '..', '..', 'ui', 'src', 'projects', 'page', 'ProjectPage.tsx'), 'utf8');
  assert.match(view, /<BoardPanel project=\{project\} \/>/);
  const panel = src.slice(src.indexOf('export function BoardPanel'), src.indexOf('function Board('));
  assert.match(panel, /enabled !== 'yes'\) return null/, 'nothing renders until the core answers the probe');
});

test('C19 Save what we learned: offered once when an item is closed without a note; the draft carries the run result and the agents\' notes, capped, and is only a draft', () => {
  assert.equal(shouldOfferNote('review', 'done', 0), true);
  assert.equal(shouldOfferNote('review', 'done', 1), false, 'already has a note');
  assert.equal(shouldOfferNote('done', 'done', 0), false, 'not a new close');
  assert.equal(shouldOfferNote('doing', 'review', 0), false);
  const i = I('wi_000000000009', 'done', 0, { title: 'Ship pricing', lastRun: { taskId: 't', status: 'done', endedAt: '', tainted: false, preview: 'Cut the tiers to three.' },
    activity: [{ at: '', by: { kind: 'agent', id: 'scout' }, kind: 'note', text: 'Annual toggle confused  people' }, { at: '', by: { kind: 'owner' }, kind: 'note', text: 'owner note is not an agent note' }] });
  const d = learnDraft(i, (id) => id.toUpperCase());
  assert.equal(d.title, 'Ship pricing: what we learned');
  assert.match(d.body, /What the last run reported:\nCut the tiers to three\./); assert.match(d.body, /- SCOUT: Annual toggle confused people/); assert.ok(!d.body.includes('owner note'));
  assert.match(d.body, /What we learned:\n- $/);
  assert.ok(learnDraft(I('wi_000000000008', 'done', 0, { title: 'x'.repeat(120), lastRun: { taskId: 't', status: 'done', endedAt: '', tainted: false, preview: 'y'.repeat(9000) } }), (x) => x).body.length <= 4000);
});

test('polish 0.3.1: an accepted proposal does not read "Not reviewed"; the other review states keep their words', () => {
  const plain = I('wi_000000000001', 'backlog', 0, { trust: 'untrusted', createdBy: { kind: 'agent', id: 'scout' } });
  assert.deepEqual(reviewBadge(plain), { tone: 'warn', text: 'Not reviewed' });
  const acc = { ...plain, acceptedAt: '2026-10-15T08:00:00.000Z' };
  assert.deepEqual(reviewBadge(acc), { tone: 'accepted', text: 'Accepted, runs ask first' });
  assert.ok(!/not reviewed/i.test(cardLabel(acc, (x) => x)), 'the card name agrees with the badge');
  assert.ok(/not reviewed/i.test(cardLabel(plain, (x) => x)), 'an unaccepted agent item still says so');
  assert.deepEqual(reviewBadge({ ...plain, createdBy: { kind: 'agent', id: 'scout', tainted: true } }), { tone: 'taint', text: 'Outside content, not reviewed' });
  assert.deepEqual(reviewBadge({ ...acc, createdBy: { kind: 'agent', id: 'scout', tainted: true } }), { tone: 'taint', text: 'Accepted, outside content' });
  assert.equal(reviewBadge(I('wi_000000000002', 'backlog', 0, { trust: 'human' })), null, 'a reviewed item has no badge');
});

test('polish 0.3.1: the board reads its review badge from one helper, and the work-item dialog keeps Save, Run and Delete in the Modal footer', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'ui', 'src', 'projects', 'board', 'BoardPanel.tsx'), 'utf8');
  assert.equal((src.match(/<ReviewNote item=\{i\} \/>/g) ?? []).length, 2, 'the card and the list row both use the note');
  assert.equal((src.match(/reviewBadge\(item\)/g) ?? []).length, 1, 'one place turns the helper into a badge');
  assert.doesNotMatch(src, /Not reviewed<\/span>/, 'no hard-coded "Not reviewed" badge is left');
  const dialog = src.slice(src.indexOf('function ItemDialog('));
  const foot = dialog.indexOf('footer={<div className="bd-actions">');
  const form = dialog.indexOf('<form id="bd-item-form"');
  assert.ok(foot > 0 && form > 0, 'the action row is the Modal footer and the form has an id');
  assert.ok(foot < form, 'the footer is passed to Modal, outside the scrolling form');
  const footer = dialog.slice(foot, form);
  assert.match(footer, /type="submit" form="bd-item-form"/, 'Save is in the footer and submits the form by id');
  assert.match(footer, /Run this item/); assert.match(footer, /Delete/); assert.match(footer, /Cancel/);
  assert.doesNotMatch(dialog.slice(form, dialog.indexOf('</Modal>')), />Run this item<|>Really delete<|>Delete</, 'the main actions are not left inside the scrolling body (the learn sub-form keeps its own)');
});

test('polish 0.3.1: the work-item dialog is a Modal, and the Modal portals to the body (PR #156), so a scrolling project page cannot cut its top off', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'ui', 'src', 'projects', 'board', 'BoardPanel.tsx'), 'utf8');
  const dialog = src.slice(src.indexOf('function ItemDialog('));
  assert.match(dialog, /return \(\n    <Modal /, 'the dialog is the shared Modal, not a second portal');
  const modal = readFileSync(join(here, '..', '..', 'ui', 'src', 'components', 'Modal.tsx'), 'utf8');
  assert.match(modal, /createPortal\(dialog, document\.body\)/, 'the shared Modal renders into the body');
});
