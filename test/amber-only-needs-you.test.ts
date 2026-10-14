/**
 * Amber (--warn) means one thing: something needs you (an approval or question waiting, a paused run that needs Continue, a failing
 * Doctor check, a budget reached). Working, thinking, queued, a busy room, a starting computer and a due date a few days out are
 * ordinary activity and read neutral; live work is mint. With a lot of agents running, amber on every one of those turned the whole
 * window gold and drowned the one card that needed the owner. This pins the classes that went neutral, and the one blink that stays.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { chipModel, lightLabel } from '../ui/src/blender/chipModel.js';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const UI = join(REPO, 'ui', 'src');

interface Rule { selectors: string[]; body: string; file: string }

const cssFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? cssFiles(p) : n.endsWith('.css') ? [p] : [];
});

const rules: Rule[] = cssFiles(UI).flatMap((file) => {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean), body: m[2]!, file,
  }));
});

const rulesFor = (selector: string): Rule[] => rules.filter((r) => r.selectors.includes(selector));
const usesAmber = (body: string): boolean => /var\(--warn|rgba\(255, ?204, ?102|#ffcc66/i.test(body);

/** Activity and state classes that must never be amber, and never blink amber. */
const NEUTRAL = [
  '.ml-thinking i',                        // the mood label under a working bust ("Deliberating")
  '.pip-busy', '.pill-busy', '.pill-busy i', // a room with bots active; a computer starting
  '.st-queued',                            // a task waiting for a slot
  '.bd-due.d-soon', '.bd-due.d-today',     // a due date on the board (overdue stays red)
  '.conn-connecting .conn-dot',            // the core link coming up
  '.set-status.st-checking .set-dot',      // a settings check in flight
  '.upd-badge.tone-busy .upd-badge-dot', '.upd-badge.tone-progress .upd-badge-dot', // an update downloading
  '.mtag-esc',                             // "escalated" tag on a reply
  '.bd-card.untrusted', '.bd-warn',        // work items an agent filed that you have not marked reviewed (most of the board)
  '.proj-note',                            // the plain archived / read-only notes on a project
];

describe('amber means something needs you', () => {
  for (const sel of NEUTRAL) {
    it(`${sel} is not amber`, () => {
      const found = rulesFor(sel);
      assert.ok(found.length > 0, `${sel} should still exist in the stylesheets`);
      for (const r of found) assert.ok(!usesAmber(r.body), `${sel} uses --warn in ${r.file}: ${r.body.trim()}`);
    });
  }

  it('amber and blinking meet only on the needs-you mood label', () => {
    const both = rules.filter((r) => usesAmber(r.body) && /animation[^;]*\bblink\b|animation[^;]*pulse/.test(r.body));
    assert.deepEqual(both.flatMap((r) => r.selectors), ['.ml-awaiting i']);
  });

  it('the needs-you states stay amber', () => {
    for (const sel of ['.ml-awaiting i', '.st-paused', '.working.waiting i', '.approval-head', '.proj-note.needs', '.agent-sub.warn', '.tb-doctor.bad']) {
      const found = rulesFor(sel);
      assert.ok(found.length > 0, `${sel} should exist`);
      assert.ok(found.some((r) => usesAmber(r.body)), `${sel} should be amber`);
    }
  });

  it('the neutral colours that replaced amber are readable in both themes (text 4.5:1, dots 3:1)', () => {
    const tokens = readFileSync(join(UI, 'styles', 'tokens.css'), 'utf8');
    const block = (head: RegExp): Record<string, string> => {
      const body = head.exec(tokens)?.[1] ?? '';
      return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!]));
    };
    const lum = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string): number => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
    for (const [theme, head] of [['dark', /:root\s*\{([^}]*)\}/], ['light', /:root\[data-theme='light'\]\s*\{([^}]*)\}/]] as const) {
      const t = block(head);
      for (const surface of ['--bg', '--surface', '--surface-2', '--surface-3']) {
        assert.ok(t[surface], `${theme} ${surface} is a plain hex`);
        for (const text of ['--text', '--text-2']) assert.ok(ratio(t[text]!, t[surface]!) >= 4.5, `${theme} ${text} on ${surface}`);
        assert.ok(ratio(t['--muted']!, t[surface]!) >= 3, `${theme} --muted dot on ${surface}`);
      }
    }
  });

  it('a running Blender script is live work (mint), not a warning', () => {
    assert.equal(lightLabel('busy').tone, 'on');
    assert.equal(chipModel({ status: { enabled: true, light: 'busy' } as never, loaded: true, failed: false, absent: false, busy: false }).tone, 'on');
    // a Blender that is not listening or needs setup still asks something of the person
    assert.equal(lightLabel('disconnected').tone, 'warn');
    assert.equal(lightLabel('needs-setup').tone, 'warn');
  });

  it('an agent-written item stands out without amber; one from a run that read outside content is amber', () => {
    const plain = rulesFor('.bd-card.untrusted');
    assert.ok(plain.some((r) => /border[^;]*dashed/.test(r.body)), 'an unreviewed agent item has its own dashed marker, so it never looks like your own');
    const tainted = rulesFor('.bd-card.tainted');
    assert.ok(tainted.length > 0 && tainted.some((r) => usesAmber(r.body)), 'an item written after reading outside content is amber');
    const board = readFileSync(join(UI, 'projects', 'board', 'BoardPanel.tsx'), 'utf8');
    assert.ok(/createdBy\.kind === 'agent' && i\.createdBy\.tainted \? ' tainted'/.test(board), 'the card gets the tainted class from createdBy.tainted');
    assert.ok(/Outside content/.test(board), 'the card says why it is amber');
  });

  it('the two project notes that ask the owner to act are marked amber', () => {
    const board = readFileSync(join(UI, 'projects', 'board', 'BoardPanel.tsx'), 'utf8');
    assert.ok(/className="proj-note needs"[^>]*>\s*<strong>Written by an agent/.test(board), 'the "written by an agent, not reviewed" note is amber');
    assert.ok(/<p className="proj-note needs" role="status">This item changed/.test(board), 'the "item changed while open" note is amber');
    assert.ok(/<p className="proj-note" role="note">This project is archived/.test(board), 'the archived note stays plain');
  });
});
