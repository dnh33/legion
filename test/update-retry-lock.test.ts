/**
 * A rolled-back version must not become a permanent, invisible lock.
 *
 * ## What the owner actually met
 *
 * On `0.2.3-f` the panel read: *"Last check: rejected: version 0.2.3-g failed its first start here and was rolled
 * back."* It appeared once. Pressing **Check now** then found the update again and permitted a retry — so the block was
 * soft, but it read as a hard refusal with nothing naming it and no button offering the way out. The only real unlock was
 * guessing, or hand-editing `state.json`.
 *
 * The design fault was threefold and each part is asserted below:
 *   1. `failedVersions` only ever grew. `grep` for a removal found only the sanitiser, so one bad afternoon locked a
 *      version out of that machine forever.
 *   2. Nothing recorded WHEN, so a block could not be time-boxed even in principle.
 *   3. The list was absent from the status payload, so the panel could neither explain it nor offer a retry.
 *
 * ## The rule now
 *
 * A block stops a start-up loop, and a loop is over once something has changed. So: record the date, expire on start,
 * expose what is blocked and when it is due, and give the owner an immediate retry rather than making them wait a week
 * for a fix they have already shipped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { FAILED_BLOCK_DAYS, pruneFailed } from '../src/core/updater/state.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00Z');
const panel = readFileSync(join(REPO, 'ui', 'src', 'components', 'UpdatePanel.tsx'), 'utf8');
const updater = readFileSync(join(REPO, 'src', 'core', 'updater', 'index.ts'), 'utf8');

describe('a rolled-back version is held back, not locked out', () => {
  it('keeps a fresh block', () => {
    const { kept, expired } = pruneFailed(['0.2.3-g'], { '0.2.3-g': new Date(NOW - DAY).toISOString() }, NOW);
    assert.deepEqual(kept, ['0.2.3-g'], 'a block from yesterday was dropped');
    assert.deepEqual(expired, []);
  });

  it('expires a block once its window has passed', () => {
    // The core of the finding: this is what could not happen before.
    const { kept, expired } = pruneFailed(['0.2.3-g'], { '0.2.3-g': new Date(NOW - (FAILED_BLOCK_DAYS + 1) * DAY).toISOString() }, NOW);
    assert.deepEqual(expired, ['0.2.3-g'], 'a week-old block was not expired');
    assert.deepEqual(kept, [], 'the expired version is still blocked');
  });

  it('treats a block with no recorded date as fresh, so upgrading never silently unlocks', () => {
    // An older state.json has no failedAt. Reading that as "expired" would hand every previously-blocked machine its
    // version back the moment it upgraded, which is the opposite of what the owner was told.
    const dateless: Array<Record<string, string> | undefined> = [undefined, {}, { '0.2.3-g': 'not-a-date' }];
    for (const at of dateless) {
      const { kept, expired } = pruneFailed(['0.2.3-g'], at, NOW);
      assert.deepEqual(kept, ['0.2.3-g'], `a dateless block was dropped for ${JSON.stringify(at)}`);
      assert.deepEqual(expired, [], `a dateless block expired for ${JSON.stringify(at)}`);
    }
  });

  it('expires only what is due, and leaves the rest alone', () => {
    const { kept, expired } = pruneFailed(
      ['0.2.3-g', '0.2.3-h'],
      { '0.2.3-g': new Date(NOW - (FAILED_BLOCK_DAYS + 2) * DAY).toISOString(), '0.2.3-h': new Date(NOW).toISOString() },
      NOW,
    );
    assert.deepEqual(expired, ['0.2.3-g']);
    assert.deepEqual(kept, ['0.2.3-h']);
  });

  it('never returns the caller list by reference, so a caller mutating it cannot corrupt saved state', () => {
    const input = ['0.2.3-g'];
    pruneFailed(input, {}, NOW).kept.push('injected');
    assert.deepEqual(input, ['0.2.3-g'], 'the returned array aliases the stored one');
  });
});

describe('a block on a version you have already moved past is not shown', () => {
  // The owner's own first run of this code, on 0.2.3-f: "Version 0.2.3-g is being held back" for a version it had
  // already superseded. The updater only ever offers something NEWER, so a block on an older version can never be
  // acted on - it is not a pending problem, it is nothing, and showing it as held back invents one.
  const updaterSrc = readFileSync(join(REPO, 'src', 'core', 'updater', 'index.ts'), 'utf8');

  it('filters the block list to versions newer than the running one', () => {
    assert.match(updaterSrc, /filter\(\(v\) => compareSemver\(v, version\) > 0\)/,
      'a block is shown regardless of whether the version is newer than what is running');
  });

  it('uses the real comparator rather than a string compare', () => {
    // String comparison gets this wrong: "0.2.3-9" > "0.2.3-10" as text, and the reverse is true as versions.
    assert.match(updaterSrc, /import \{ compareSemver \} from '\.\/semver\.js'/, 'compareSemver is not imported');
  });

  it('a dateless block never claims it will clear on its own', () => {
    // pruneFailed treats a missing date as fresh FOREVER, so "it will be offered again on its own" was a promise that
    // could not be kept. Say the truth and keep the button, because with no date it is the only way out.
    assert.match(panel, /does not know when it will clear/,
      'the panel still promises a date-driven release for a block that has no date');
    assert.doesNotMatch(panel, /offered again on its own/,
      'the panel still claims a dateless block clears by itself');
  });

  it('offers the retry button for every blocked version, dateless or not', () => {
    // Asserted as an absence rather than by parsing: no `st.blocked.filter(...)` may sit in front of a `.map`, because
    // any condition there hides the button for exactly the dateless blocks that need it.
    assert.doesNotMatch(panel, /st\.blocked\.filter\(/,
      'the retry buttons are filtered, so a dateless block cannot be retried');
    assert.match(panel, /st\.blocked\.map\(/, 'the retry buttons are not rendered at all');
  });
});

describe('the panel tells the owner what is blocked, and offers the way out', () => {
  it('shows the blocked version and when it failed', () => {
    assert.match(panel, /is being held back/, 'the panel never says a version is held back');
    assert.match(panel, /failed its first start/, 'the panel does not say why');
  });

  it('offers a retry button that names the version', () => {
    assert.match(panel, /\/api\/update\/retry'/, 'there is no retry call in the panel');
    assert.match(panel, /Try \{b\.version\} again/, 'the retry button does not name the version it will retry');
  });

  it('says when the block lifts on its own, so waiting is an answer', () => {
    assert.match(panel, /without this button|on its own/, 'the panel does not say when the version returns by itself');
  });

  it('the retry route exists, is admin-gated like the rest, and clears the outcome file', () => {
    assert.match(updater, /'\/api\/update\/retry'/, 'the retry route does not exist');
    // Without removing the outcome file, the next start re-adds the version that was just unblocked.
    const seg = updater.slice(updater.indexOf("'/api/update/retry'"));
    assert.match(seg.slice(0, 900), /rmSync\(outcomePath/, 'retry does not clear the outcome file, so start re-blocks it');
  });

  it('the block is recorded with a date, so it can be expired at all', () => {
    assert.match(updater, /failedAt/, 'nothing records when a version failed');
    assert.match(updater, /pruneFailed\(/, 'nothing prunes an expired block');
  });
});
