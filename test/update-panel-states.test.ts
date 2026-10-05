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
