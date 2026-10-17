// test/web-copy.test.ts: the words of the web cards and the web lines (Task 20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_CARD, WEB_NOTICE, WEB_LINE, CONSENT_LINE } from '../ui/src/gates/presetsLogic.js';
import { PRESET_LINES } from '../src/shared/gates-registry.js';
import { webCardSummary } from '../src/shared/web-copy.js';

const texts = (): string[] => [
  WEB_CARD.title('a.com'), WEB_CARD.body('a.com', '/x'), WEB_CARD.bodyCode, WEB_CARD.buttons.always('a.com'), WEB_CARD.buttons.goal, WEB_CARD.buttons.once, WEB_CARD.buttons.deny,
  WEB_CARD.many(3, ['a', 'b', 'c']), WEB_CARD.egressTitle, WEB_NOTICE, WEB_LINE, CONSENT_LINE, PRESET_LINES.smart,
  ...(['new-host', 'query', 'userinfo', 'odd-path', 'http', 'port', 'ip', 'long-search', 'budget', 'secret-read'] as const).map((why) => webCardSummary({ why, host: 'a.com', path: '/x' })),
];

test('web copy has no em dash and no "this computer"', () => {
  const all = JSON.stringify(texts());
  assert.ok(!all.includes('—') && !/this computer|this machine/i.test(all));
});

test('every web line and the Smart line say it plainly: WEB_LINE and WEB_NOTICE, and the Smart line does not speak of websites', () => {
  assert.equal(WEB_LINE, 'Agents ask before they read a new website. Sites on your list open without asking.');
  assert.equal(WEB_NOTICE, 'Agents read sites on your list. A new site asks once.');
  assert.equal(CONSENT_LINE, 'Agents will run the code they write, like tests and builds.');
  assert.doesNotMatch(PRESET_LINES.smart, /websites/i);
});

test('buttons are exactly the four answers', () => assert.deepEqual([WEB_CARD.buttons.always('x.com'), WEB_CARD.buttons.goal, WEB_CARD.buttons.once, WEB_CARD.buttons.deny], ['Always allow x.com', 'Allow for this goal', 'Allow once', 'Deny']));

test('the egress card title differs from the Smart card title', () => assert.notEqual(WEB_CARD.egressTitle, WEB_CARD.title('x.com')));

test('the card summary: a new site reads as the card does; a reason line follows when the site is not the news', () => {
  assert.equal(webCardSummary({ why: 'new-host', host: 'a.com', path: '/x' }), `${WEB_CARD.title('a.com')}\n${WEB_CARD.body('a.com', '/x')}`);
  assert.match(webCardSummary({ why: 'odd-path', host: 'a.com', path: '/x' }), /long code/);
  assert.match(webCardSummary({ why: 'long-search', host: '', path: '', search: 'x' }), /^Search the web\?/);
});
