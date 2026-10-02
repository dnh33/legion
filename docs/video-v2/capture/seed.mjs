/**
 * Demo data for the trailer screenshots. Everything goes through the REAL core HTTP API (admin headers) or the scripted model; nothing is
 * written into the core's files. All content is invented. Used only by capture.mjs.
 */
const F = (o) => o;

/** 34 invented Library notes about a made-up small web team. [id, type, title, body, tags] */
export const NOTES = [
  ['n-retry', 'decision', 'Retry only idempotent calls', '## Chose\nRetry GET and PUT with backoff; never retry POST without a key.\n\n## Why\nDouble charges were the worst bug of the quarter.\n\n## Rejected\n- Retry everything\n- No retries\n\n## Revisit if\nThe payment provider ships idempotency keys.', ['api', 'reliability']],
  ['n-idem', 'pattern', 'Idempotency keys on every write', '## When\nA client can resend a write.\n\n## Do\nSend a key; store the result under it for 24 hours.\n\n## Because\nA second send then returns the first answer.', ['api']],
  ['n-backoff', 'pattern', 'Exponential backoff with jitter', '## When\nCalling a service that may be busy.\n\n## Do\nWait 2^n times 100 ms, plus a random slice.\n\n## Because\nSynchronised clients make the outage longer.', ['reliability']],
  ['n-timeouts', 'lesson', 'Set a timeout on every outbound call', 'The default is no timeout. One slow partner froze our worker pool for an hour.', ['reliability']],
  ['n-cache', 'concept', 'Cache invalidation by version key', 'Put the content version in the cache key instead of deleting entries. Old keys expire by themselves.', ['cache']],
  ['n-cdn', 'decision', 'Serve images through the CDN, not the app', '## Chose\nA CDN with a one-year cache and hashed file names.\n\n## Why\nThe app server spent 40 percent of its time on images.\n\n## Rejected\n- Resize on request\n\n## Revisit if\nWe need private images.', ['cache', 'perf']],
  ['n-hash', 'pattern', 'Hash file names for long caching', '## When\nShipping static assets.\n\n## Do\nPut a content hash in the name.\n\n## Because\nYou can cache for a year and still ship today.', ['cache']],
  ['n-tests', 'concept', 'Test pyramid for the web app', 'Many fast unit tests, some API tests, a handful of browser tests for the money paths.', ['testing']],
  ['n-flaky', 'mistake', 'Flaky tests hid a real race', '## What happened\nWe re-ran a red build until it went green.\n\n## Root cause\nTwo writers on one row.\n\n## Fix\nA row lock.\n\n## Lesson\nA test that fails one time in ten is a bug report.\n\n## Prevents\nShipping races', ['testing', 'reliability']],
  ['n-fixtures', 'pattern', 'Build test data with small factories', '## When\nA test needs a user or an order.\n\n## Do\nCall a factory with only the fields the test cares about.\n\n## Because\nShared fixtures break far from the cause.', ['testing']],
  ['n-release', 'concept', 'Release checklist', 'Freeze Thursday, tag Friday morning, watch the dashboards for an hour, never ship on a Friday afternoon.', ['release']],
  ['n-flags', 'decision', 'Ship risky work behind flags', '## Chose\nFlags with an owner and an end date.\n\n## Why\nWe can turn a bad change off without a deploy.\n\n## Rejected\n- Long branches\n\n## Revisit if\nFlags pile up past twenty.', ['release']],
  ['n-rollback', 'lesson', 'Practise the rollback', 'A rollback nobody has tried is a guess. We rehearse it once a month on staging.', ['release']],
  ['n-onboard', 'concept', 'First-week onboarding path', 'Day one: run the app. Day two: fix a small bug. Day three: pair on a review. Day five: ship something tiny.', ['team']],
  ['n-review', 'pattern', 'Small reviews, fast answers', '## When\nOpening a pull request.\n\n## Do\nKeep it under 300 lines; ask for one thing.\n\n## Because\nBig reviews get skimmed.', ['team']],
  ['n-docs', 'decision', 'Docs live next to the code', '## Chose\nMarkdown in the repo.\n\n## Why\nIt changes in the same pull request as the code.\n\n## Rejected\n- A separate wiki\n\n## Revisit if\nSupport needs to edit it.', ['team', 'docs']],
  ['n-tokens', 'concept', 'Design tokens', 'Colours, spacing and type sizes as named values. One file feeds the web app and the emails.', ['design']],
  ['n-dark', 'decision', 'Dark theme from the same tokens', '## Chose\nTwo token sets, one component set.\n\n## Why\nNo second stylesheet to keep in step.\n\n## Rejected\n- Invert filter\n\n## Revisit if\nWe add a high-contrast theme.', ['design']],
  ['n-contrast', 'lesson', 'Check contrast on the dark theme first', 'Grey on grey passed on light and failed on dark. Check the darker one first.', ['design', 'a11y']],
  ['n-a11y', 'pattern', 'Keyboard first, mouse second', '## When\nBuilding any control.\n\n## Do\nReach it, use it and leave it with the keyboard before styling it.\n\n## Because\nFocus bugs are cheap now and costly later.', ['a11y']],
  ['n-logs', 'concept', 'Structured logs', 'One JSON line per event with a request id. You can follow one request across services.', ['ops']],
  ['n-alert', 'decision', 'Page on symptoms, not causes', '## Chose\nAlert on slow pages and failed checkouts.\n\n## Why\nCPU alerts woke people for nothing.\n\n## Rejected\n- Alert on every metric\n\n## Revisit if\nWe lose track of causes.', ['ops']],
  ['n-postmortem', 'pattern', 'Blameless post-mortems', '## When\nAfter any incident.\n\n## Do\nWrite what happened, why the system allowed it and one fix.\n\n## Because\nPeople hide what they fear to share.', ['ops', 'team']],
  ['n-queue', 'concept', 'Work queues for slow jobs', 'Anything over two seconds moves to a queue. The page shows "working" and polls.', ['perf', 'api']],
  ['n-pagination', 'lesson', 'Paginate by cursor, not by page number', 'Page numbers skip and repeat rows when data changes. A cursor does not.', ['api']],
  ['n-errors', 'pattern', 'Errors say what to do next', '## When\nShowing an error to a person.\n\n## Do\nName the problem and one next step.\n\n## Because\n"Something went wrong" helps nobody.', ['design', 'api']],
  ['n-i18n', 'idea', 'Translate the onboarding emails first', '## Pitch\nThey reach every new user and are short.\n\n## Status\nParked\n\n## Score\n6', ['idea']],
  ['n-search', 'idea', 'Search the help centre from the app bar', '## Pitch\nFewer support tickets.\n\n## Status\nOpen\n\n## Score\n7', ['idea']],
  ['n-secrets', 'mistake', 'A test key was committed', '## What happened\nA throwaway test key landed in the repo.\n\n## Root cause\nNo scan before push.\n\n## Fix\nRotated it and added a pre-push scan.\n\n## Lesson\nAssume anything pushed is public.\n\n## Prevents\nLeaked keys', ['ops']],
  ['n-migrate', 'pattern', 'Two-step database changes', '## When\nRenaming or dropping a column.\n\n## Do\nAdd the new one, move the code, drop the old one a week later.\n\n## Because\nA deploy and a migration never land at the same instant.', ['ops', 'api']],
  ['n-budget', 'decision', 'Keep the page under 200 KB', '## Chose\nA hard budget in CI.\n\n## Why\nSlow phones are our median user.\n\n## Rejected\n- A soft goal\n\n## Revisit if\nThe median phone changes.', ['perf']],
  ['n-lazy', 'pattern', 'Load below-the-fold images late', '## When\nA page has more than a screen of images.\n\n## Do\nMark them lazy and give them a size.\n\n## Because\nThe first paint stays fast and the layout does not jump.', ['perf']],
];

/** [from, rel, to] */
export const EDGES = [
  ['n-retry', 'depends_on', 'n-idem'], ['n-retry', 'relates', 'n-backoff'], ['n-timeouts', 'relates', 'n-retry'], ['n-backoff', 'relates', 'n-timeouts'],
  ['n-cdn', 'depends_on', 'n-hash'], ['n-cache', 'relates', 'n-cdn'], ['n-hash', 'relates', 'n-cache'], ['n-budget', 'relates', 'n-lazy'], ['n-cdn', 'relates', 'n-budget'],
  ['n-tests', 'relates', 'n-fixtures'], ['n-flaky', 'teaches', 'n-tests'], ['n-flaky', 'relates', 'n-retry'], ['n-release', 'relates', 'n-flags'], ['n-flags', 'relates', 'n-rollback'], ['n-release', 'relates', 'n-rollback'],
  ['n-onboard', 'relates', 'n-review'], ['n-review', 'relates', 'n-docs'], ['n-onboard', 'relates', 'n-docs'], ['n-tokens', 'relates', 'n-dark'], ['n-dark', 'relates', 'n-contrast'], ['n-contrast', 'relates', 'n-a11y'], ['n-tokens', 'relates', 'n-errors'],
  ['n-logs', 'relates', 'n-alert'], ['n-alert', 'relates', 'n-postmortem'], ['n-postmortem', 'relates', 'n-rollback'], ['n-queue', 'relates', 'n-backoff'], ['n-queue', 'relates', 'n-pagination'], ['n-pagination', 'part_of', 'n-errors'],
  ['n-secrets', 'relates', 'n-release'], ['n-secrets', 'relates', 'n-postmortem'], ['n-migrate', 'relates', 'n-release'], ['n-migrate', 'relates', 'n-rollback'], ['n-i18n', 'relates', 'n-onboard'], ['n-search', 'relates', 'n-docs'],
  ['n-a11y', 'relates', 'n-review'], ['n-logs', 'relates', 'n-flaky'], ['n-lazy', 'relates', 'n-cache'], ['n-idem', 'relates', 'n-queue'], ['n-tests', 'relates', 'n-release'],
];

export async function seedLibrary(s) {
  for (const [id, type, title, body, tags] of NOTES) {
    const r = await s.call('POST', '/api/kg/nodes', { id, type, title, body, tags, scope: 'shared' });
    if (r.status !== 200 && r.status !== 201) throw new Error(`note ${id}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`);
  }
  for (const [from, rel, to] of EDGES) {
    const r = await s.call('POST', '/api/kg/edges', { from, to, rel });
    if (r.status !== 200 && r.status !== 201) throw new Error(`edge ${from}-${to}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`);
  }
}

/** Runs one task through the real engine with the scripted model and waits for the end (or, with waitFor 'approval', for the card). */
export async function runTask(s, agentId, prompt, steps, { projectId, wait = true } = {}) {
  await s.script({ agent: agentId, promptIncludes: prompt }, steps);
  const r = await s.call('POST', '/api/tasks', { agentId, prompt, ...(projectId ? { projectId } : {}) });
  if (r.status !== 201) throw new Error(`task ${agentId}: ${r.status} ${JSON.stringify(r.json ?? r.text)}`);
  if (!wait) return r.json;
  return s.until(async () => { const t = (await s.call('GET', `/api/tasks/${r.json.id}`)).json?.task; return t && ['done', 'error', 'cancelled'].includes(t.status) ? t : null; }, 20000, `task ${agentId}`);
}

export const note = F;
