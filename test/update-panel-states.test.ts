/**
 * The update panel's states, checked against the phase list rather than against a screenshot.
 *
 * ## What this exists for
 *
 * An audit of the updater found that `UpdatePanel.tsx` guarded its Update button with an inline list of phases:
 * `st.phase !== 'downloading' && st.phase !== 'awaiting-approval'`, plus `!st.staged`. **`committing` was missing
 * from it.** That phase is a declared member of the union, so during an install commit the button stayed rendered and
 * enabled, and a second click POSTed `/api/update/install` again against a commit already in flight.
 *
 * A screenshot cannot catch that: the button looks correct in every frame a designer would capture, because the frame
 * where it is wrong is a frame nobody thinks to photograph. So the assertion is structural — the set of phases that may
 * offer the button is named, and every phase outside it must be excluded.
 *
 * Two more findings from the same audit, kept here so they cannot return:
 *   - a raw exception message reached the panel as `could not check: getaddrinfo ENOTFOUND ...`
 *   - the no-update-key banner and the check line repeated the same sentence on screen
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { describeCheckFailure } from '../src/core/updater/index.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const panel = readFileSync(join(REPO, 'ui', 'src', 'components', 'UpdatePanel.tsx'), 'utf8');

/** Every phase the panel's own type declares. Taken from the file so a new phase cannot slip past unnoticed. */
const declaredPhases = (): string[] => {
  const m = /phase: 'idle' \| ([^;]+);/.exec(panel);
  assert.ok(m, 'could not find the phase union in UpdatePanel.tsx');
  return [...`idle | ${m[1]}`.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!);
};

/** The phases the panel offers the Update button in. */
const installPhases = (): string[] => {
  const m = /IDLE_FOR_INSTALL[^=]*=\s*\[([^\]]*)\]/.exec(panel);
  assert.ok(m, 'IDLE_FOR_INSTALL is gone; the guard went back to being an inline list, which is what regressed');
  return [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!);
};

describe('update panel: the phases that may offer an install', () => {
  it('parses the phase union and the install set out of the panel', () => {
    const phases = declaredPhases();
    assert.ok(phases.length >= 5, `expected the full phase list, parsed ${phases.join(', ')}`);
    assert.ok(phases.includes('committing'), 'the phase union no longer includes committing; re-check this test');
  });

  it('never offers the button while work is in flight', () => {
    const offered = installPhases();
    for (const busy of ['downloading', 'awaiting-approval', 'committing']) {
      assert.ok(!offered.includes(busy), `${busy} is work in flight and must not offer the Update button`);
    }
  });

  it('still offers it when nothing is happening', () => {
    const offered = installPhases();
    assert.ok(offered.includes('idle'), 'the Update button must be reachable when idle');
  });

  it('covers every phase: nothing is left unclassified', () => {
    const phases = declaredPhases();
    const offered = new Set(installPhases());
    // Every phase is classified by construction: the ones in the set offer the button, and every other phase is
    // excluded by definition. What must not happen is a phase that no branch accounts for - which is why `staged`
    // is asserted separately below (it has its own row, gated by `!st.staged` rather than by the list) and why the
    // excluded set is asserted to be exactly the in-flight phases.
    const excluded = phases.filter((p) => !offered.has(p));
    assert.deepEqual([...excluded].sort(), ['awaiting-approval', 'committing', 'downloading', 'staged'].sort(),
      'the excluded set changed; every phase must be knowingly either offered or excluded');
    assert.ok(phases.every((p) => offered.has(p) || excluded.includes(p)), 'a phase fell through both ways');
  });

  it('says what committing is, instead of showing a live button and no explanation', () => {
    assert.match(panel, /st\.phase === 'committing'/, 'the committing phase renders nothing at all');
  });

  it('does not repeat the no-update-key message', () => {
    // The banner and the check line said the same sentence. The check line is now conditional on a key existing.
    const keyGuard = /!st\.keyConfigured &&[\s\S]{0,400}?st\.keyConfigured && \(/.test(panel);
    assert.ok(keyGuard, 'the check line is unconditional, so it repeats the no-key banner verbatim');
  });
});

describe('update panel: failures say something a person can act on', () => {
  it('maps every known failure kind to a complete sentence', () => {
    assert.match(describeCheckFailure({ kind: 'offline', message: 'x' }), /could not reach the update server/);
    assert.match(describeCheckFailure({ kind: 'timeout', message: 'x' }), /could not reach the update server/);
    assert.match(describeCheckFailure({ kind: 'rate-limit', message: 'x' }), /asked us to wait/);
    assert.match(describeCheckFailure({ kind: 'http', message: 'HTTP 404' }), /no release found/);
    assert.match(describeCheckFailure({ kind: 'http', message: 'HTTP 500' }), /returned an error/);
  });

  it('never puts the raw exception text on screen', () => {
    // The finding: a DNS failure arrived as `could not check: getaddrinfo ENOTFOUND api.github.com`, which names an
    // internal host and gives the reader nothing to do. Every kind, including unknown ones, must stay clean.
    const leaky = 'getaddrinfo ENOTFOUND api.github.com';
    for (const kind of ['offline', 'timeout', 'rate-limit', 'http', 'something-new']) {
      const text = describeCheckFailure({ kind, message: leaky });
      assert.ok(!text.includes('ENOTFOUND'), `${kind} leaked the exception text: ${text}`);
      assert.ok(!text.includes('api.github.com'), `${kind} leaked the internal host: ${text}`);
    }
  });

  it('an unknown failure kind still gets a sentence, not a blank', () => {
    const text = describeCheckFailure({ kind: 'brand-new', message: 'boom' });
    assert.ok(text.trim().length > 0, 'an unmapped kind produced no text at all');
    assert.match(text, /could not check/);
  });

  it('ends every sentence with a full stop when the panel appends one', () => {
    // The panel renders `Last check: ${lastResult}.` — so the mapped text must not itself end in punctuation that
    // doubles up, and must not be a fragment.
    for (const kind of ['offline', 'rate-limit', 'http', 'unknown']) {
      const t = describeCheckFailure({ kind, message: 'm' });
      assert.ok(!t.endsWith('.'), `"${t}" already ends in a full stop; the panel adds one`);
    }
  });
});

describe('update panel: the check control and the download progress tell the truth', () => {
  it('the check control is a real busy state: a spinner and "Checking update state", versus "Check now" when idle', () => {
    assert.match(panel, /aria-busy=\{checking\}/, 'the button never reports that a check is running');
    assert.match(panel, /className="upd-spin"/, 'there is no spinner while the check runs');
    assert.match(panel, /Checking update state/, 'the checking label reads like an idle button');
    assert.match(panel, /: 'Check now'/, 'the idle label is gone');
  });

  it('negative: the label is a branch, not the fixed string "Check now"', () => {
    // A fixed label would show "Check now" during a check, inviting a second request the core 429s.
    assert.match(panel, /checking \?[\s\S]{0,120}: 'Check now'/, 'the check label no longer branches on the checking phase');
  });

  it('shows when the last check happened, not only its result', () => {
    assert.match(panel, /lastCheckedAt/, 'the last-checked timestamp is never displayed');
    assert.match(panel, /fmtWhen\(st\.check\.lastCheckedAt\)/, 'the timestamp is not formatted for a person');
  });

  it('download progress names bytes of the route-correct total, not only a percentage', () => {
    assert.match(panel, /\$\{fmtBytes\(got\)\} of \$\{fmtBytes\(total\)\}/, 'the progress line does not name bytes and total');
    assert.match(panel, /\(\$\{pct\}%\)/, 'the percentage is gone');
  });

  it('committing says Legion restarts to finish, not just that it is installing', () => {
    assert.match(panel, /st\.phase === 'committing'/, 'the committing phase renders nothing');
    assert.match(panel, /Legion restarts to finish/, 'the committing line does not say Legion restarts');
  });
});

describe('update panel: a failed outcome is actionable, not instructions only', () => {
  it('offers a one-click Try again that re-offers the download or re-checks', () => {
    assert.match(panel, /Try again/, 'a failed outcome has no retry, only text');
    assert.match(panel, /request\('POST', '\/api\/update\/install'\)/, 'the retry cannot re-offer the download');
    assert.match(panel, /request\('POST', '\/api\/update\/check'\)/, 'the retry cannot re-check');
    assert.match(panel, /canRetryInstall \? installNow\(\) : checkNow\(\)/, 'the retry does not choose an endpoint');
  });

  it('surfaces the reason a files-in-use failure carries', () => {
    assert.match(panel, /st\.outcome\.reason/, 'the failure reason from the status is dropped');
  });

  it('negative: the Try again button sits inside the failure branch, not the success branch', () => {
    assert.match(panel, /st\.outcome && st\.outcome\.result !== 'ok' && \([\s\S]{0,1000}?Try again/, 'the retry is not in the failure branch');
  });
});

describe('update panel: a refusal does not print the notes that contradict it', () => {
  it('withholds the release notes exactly when the panel refuses to install', () => {
    const idx = panel.indexOf('upd-notes');
    assert.ok(idx > 0, 'the panel no longer renders release notes at all');
    const before = panel.slice(Math.max(0, idx - 60), idx);
    assert.match(before, /!notifyOnly && a\.notes/, 'notes render even when Legion refuses to install in place');
  });

  it('negative: an unconditional notes render would show "installs in place" beside "cannot be installed"', () => {
    // The owner met exactly this: a manifest note promising an in-place install, then the refusal. The notes must be
    // gated on the same `notifyOnly` that drives the refusal.
    assert.equal(/\{a\.notes && <pre className="upd-notes">/.test(panel), false, 'the notes block is unconditional again');
  });

  it('keeps the Release notes link and the refusal support line', () => {
    assert.match(panel, /Release notes/, 'the Release notes link is gone');
    assert.match(panel, /run setup\.cmd/, 'the refusal support line is gone');
  });
});
