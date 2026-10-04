/**
 * The Compaction settings screen, and the Blender export-folder field beside it.
 *
 * The section's numbers are the user's to type, so the range check that gives feedback BEFORE the server sees the
 * request lives in a pure block in the TSX. That block is cut out of the source and run here for real, and its
 * ranges are compared against COMPACTION_LIMITS — the same table the server validates against — so the form and the
 * server can never disagree about what is in range. The rest (nav entry, section branch, the Blender write) is
 * pinned by reading the source, the way test/blender-ui.test.ts pins the Blender screens.
 *
 * The enabled toggle is a boolean, not a range, so it is validated on its own: the shipped default, the round trip
 * through validatePatch, and — the assertion that matters — a disabled setting read back FROM config.json on disk,
 * which is what catches a section missing from the apply() persistence list.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { COMPACTION_LIMITS, DEFAULT_COMPACTION, defaultConfig, normalizeCompaction } from '../src/shared/config.js';
import { SettingsError, SettingsService, validatePatch } from '../src/core/settings.js';
import { EventBus } from '../src/core/bus.js';
import { tempDir as cleanupTemp } from './tmp-cleanup.js';

const SRC = readFileSync(join(process.cwd(), 'ui/src/components/Settings.tsx'), 'utf8');

/** CompactionDraft/COMPACTION_FIELDS/compactionDraft/compactionPatch and the usage helpers: the pure block, no JSX, run as written. */
function helpers() {
  const start = SRC.indexOf('export interface CompactionDraft');
  const end = SRC.indexOf('function CompactionSection');
  assert.ok(start > 0 && end > start, 'the compaction helper block is present');
  const code = SRC.slice(start, end).replace(/export /g, '');
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(`${js}\nreturn { COMPACTION_FIELDS, compactionDraft, compactionPatch, estimateTextTokens, contextUsageLine, ASSUMED_WINDOW_TOKENS };`)() as {
    COMPACTION_FIELDS: ReadonlyArray<{ key: string; label: string; hint: string; min: number; max: number; int: boolean }>;
    compactionDraft: (c: typeof DEFAULT_COMPACTION) => Record<string, string>;
    compactionPatch: (d: Record<string, string>) => { patch?: Record<string, unknown>; error?: string };
    estimateTextTokens: (text: string) => number;
    contextUsageLine: (usedTokens: number, windowTokens: number) => string;
    ASSUMED_WINDOW_TOKENS: number;
  };
}

type Raw = typeof DEFAULT_COMPACTION;
const draft = (over: Partial<Record<keyof Raw, string>> = {}): Record<string, string> =>
  ({ ...helpers().compactionDraft(DEFAULT_COMPACTION), ...over });

test('the six fields cover every compaction setting, in order, with labels and hints', () => {
  const f = helpers().COMPACTION_FIELDS;
  assert.deepEqual(f.map((x) => x.key), ['thresholdFraction', 'tailBudgetShare', 'summaryShare', 'protectFirst', 'contextWindowOverride', 'smallWindowTokens']);
  for (const x of f) {
    assert.ok(x.label.length > 0 && x.hint.length > 0, `${x.key} has a label and a hint`);
    assert.match(x.hint, new RegExp(`${x.min} to ${x.max}`), `${x.key}'s hint states its range`);
  }
});

test('the form ranges are exactly COMPACTION_LIMITS (the table the server rejects against), integers flagged', () => {
  const h = helpers();
  for (const x of h.COMPACTION_FIELDS) {
    const L = COMPACTION_LIMITS[x.key as keyof typeof COMPACTION_LIMITS];
    assert.ok(L, `${x.key} is a real compaction field`);
    assert.equal(x.min, L.min, `${x.key} min`);
    assert.equal(x.max, L.max, `${x.key} max`);
  }
  const ints = h.COMPACTION_FIELDS.filter((x) => x.int).map((x) => x.key);
  assert.deepEqual(ints, ['protectFirst', 'contextWindowOverride', 'smallWindowTokens'], 'only the token counts and the turn count are whole numbers');
});

test('the defaults round-trip: the draft of the shipped defaults saves back as exactly those numeric defaults', () => {
  const h = helpers();
  const d = h.compactionDraft(DEFAULT_COMPACTION);
  assert.deepEqual(d, {
    thresholdFraction: '0.5', tailBudgetShare: '0.2', summaryShare: '0.1', protectFirst: '3', contextWindowOverride: '', smallWindowTokens: '32000',
  });
  const r = h.compactionPatch(d);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.patch, {
    thresholdFraction: 0.5, tailBudgetShare: 0.2, summaryShare: 0.1, protectFirst: 3, contextWindowOverride: null, smallWindowTokens: 32_000,
  });
});

test('an empty override means "use each model\u2019s own window" (null), not zero and not a missing field', () => {
  const h = helpers();
  const r = h.compactionPatch(draft({ contextWindowOverride: '' }));
  assert.equal(r.error, undefined);
  assert.equal(r.patch!.contextWindowOverride, null);
  assert.equal(r.patch!.thresholdFraction, 0.5, 'the other fields are still carried');
});

test('values the user can type are refused before submission, naming the field and the range', () => {
  const h = helpers();
  const cases: Array<[string, string, RegExp]> = [
    ['thresholdFraction', '0', /Compaction threshold must be between 0.1 and 0.95\./],
    ['thresholdFraction', '1', /Compaction threshold must be between 0.1 and 0.95\./],
    ['tailBudgetShare', '0.7', /Recent messages kept must be between 0.02 and 0.6\./],
    ['summaryShare', '0.5', /Summary size must be between 0.02 and 0.4\./],
    ['protectFirst', '0', /First turns protected must be between 1 and 20\./],
    ['protectFirst', '21', /First turns protected must be between 1 and 20\./],
    ['protectFirst', '3.5', /First turns protected must be a whole number\./],
    ['contextWindowOverride', '0', /Context window override must be between 4096 and 4000000\./],
    ['contextWindowOverride', '4096.5', /Context window override must be a whole number\./],
    ['smallWindowTokens', '2000', /Small-window size must be between 4096 and 4000000\./],
    ['smallWindowTokens', '', /Small-window size needs a number\./],
    ['summaryShare', 'x', /Summary size must be a number\./],
  ];
  for (const [key, value, re] of cases) {
    const r = h.compactionPatch(draft({ [key]: value }));
    assert.equal(r.patch, undefined, `${key}=${value} is refused`);
    assert.match(r.error ?? '', re, `${key}=${value}`);
  }
});

test('the longest values the ranges allow are accepted; one past the top is not', () => {
  const h = helpers();
  const top = h.compactionPatch(draft({ smallWindowTokens: '4000000', contextWindowOverride: '4000000', thresholdFraction: '0.95', tailBudgetShare: '0.6', summaryShare: '0.4', protectFirst: '20' }));
  assert.equal(top.error, undefined);
  assert.equal(top.patch!.smallWindowTokens, 4000000);
  assert.equal(top.patch!.contextWindowOverride, 4000000);
  const over = h.compactionPatch(draft({ smallWindowTokens: '4000001' }));
  assert.match(over.error ?? '', /Small-window size must be between 4096 and 4000000\./);
  const low = h.compactionPatch(draft({ contextWindowOverride: '4095' }));
  assert.match(low.error ?? '', /Context window override must be between 4096 and 4000000\./);
});

test('the section is reachable from the nav and wired to the settings and reset routes', () => {
  assert.match(SRC, /\{ id: 'compaction', label: 'Compaction', hint: '[^']+' \}/, 'a Compaction entry in the NAV list');
  assert.match(SRC, /section === 'compaction' \? <CompactionSection s=\{settings\} \/>/, 'the section renders in the settings body');
  assert.match(SRC, /<SaveBar dirty=\{dirty\} busy=\{busy\} error=\{error\} onSave=\{\(\) => void save\(\)\} onReset=\{reset\} \/>/, 'the compaction SaveBar');
  assert.match(SRC, /await saveSettings\(\{ compaction: \{ \.\.\.r\.patch, enabled: on \} \}\)/, 'save writes a compaction patch through saveSettings');
  assert.match(SRC, /await resetCompaction\(\)/, 'Restore defaults calls the store reset');
  assert.match(SRC, /resetCompaction, saveSettings/, 'resetCompaction is imported from the store');
  assert.match(SRC, /if \(!r\.patch\) \{ setError\(r\.error/, 'a refused value is shown, not swallowed');
});

test('the Blender field writes blender.baseDir and names both trees it moves', () => {
  assert.match(SRC, /<Field id="bl-base" label=\{EXPORT_FOLDER_LABEL\} hint=\{EXPORT_FOLDER_HINT\}>/, 'the export-folder field uses the Blender section\u2019s own copy');
  assert.match(SRC, /await api\.setBlenderBaseDir\(baseDir\.trim\(\)\)/, 'the field writes baseDir through the Blender config route');
  assert.match(SRC, /baseBusy \? 'Saving\u2026' : 'Use this folder'/, 'the button reports its busy state');
  assert.match(SRC, /baseError && <span className="set-hint" role="alert">\{baseError\}<\/span>/, 'a failed save is shown inline');
  assert.doesNotMatch(SRC, /baseDir[^\n]*single folder/, 'the copy must not imply one destination');
});

/* ---------------- the enabled toggle (A) ---------------- */

test('enabled is an off switch: absent or true means on, and only an explicit false turns compaction off', () => {
  assert.notEqual((DEFAULT_COMPACTION as { enabled?: unknown }).enabled, false, 'the shipped default compacts');
  assert.notEqual((normalizeCompaction(undefined) as { enabled?: unknown }).enabled, false, 'a config with no block compacts');
  assert.notEqual((normalizeCompaction({}) as { enabled?: unknown }).enabled, false, 'an empty block compacts');
  assert.equal((normalizeCompaction({ enabled: false }) as { enabled?: unknown }).enabled, false, 'false is kept');
  assert.notEqual((normalizeCompaction({ enabled: true }) as { enabled?: unknown }).enabled, false, 'true keeps it on');
  assert.notEqual((normalizeCompaction({ enabled: 'no' }) as { enabled?: unknown }).enabled, false, 'a wrong-typed value falls back to on, never off');
});

test('the enabled toggle survives a round trip through validatePatch, and a wrong type names the field', () => {
  const off = validatePatch({ compaction: { enabled: false } });
  assert.equal((off.compaction as { enabled?: unknown } | undefined)?.enabled, false);
  const on = validatePatch({ compaction: { enabled: true } });
  assert.equal((on.compaction as { enabled?: unknown } | undefined)?.enabled, true);
  assert.throws(
    () => validatePatch({ compaction: { enabled: 'off' } }),
    (e: any) => e instanceof SettingsError && e.status === 400 && /compaction\.enabled must be a boolean/.test(e.message),
    'a non-boolean enabled is refused, naming the field',
  );
});

test('a disabled setting is persisted: config.json on disk carries enabled:false and reads back off', () => {
  const dir = cleanupTemp('legion-suic-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ port: 4747 }));
  const config = defaultConfig();
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  svc.patch({ compaction: { enabled: false } });
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(disk.compaction, 'compaction was written to config.json');
  assert.equal(disk.compaction.enabled, false, 'the disabled flag is on disk, not only in memory');
  // a fresh service built the way loadConfig would (the file re-normalised) reads it back as off
  const reloaded = { ...defaultConfig(), ...disk, compaction: normalizeCompaction(disk.compaction) } as any;
  const svc2 = new SettingsService({ config: reloaded, bus: new EventBus(), configPath: file, dataDir: dir });
  assert.equal((svc2.view().compaction as { enabled?: unknown }).enabled, false, 'a restart keeps it off');
});

test('the UI renders the enabled toggle and sends it with the other compaction values', () => {
  assert.match(SRC, /checked=\{on\}/, 'the toggle binds to its own boolean state');
  assert.match(SRC, /enabled: on/, 'save carries the toggle in the compaction patch');
  assert.match(SRC, /Compact long conversations/, 'the toggle is labelled');
  assert.match(SRC, /className="set-check"/, 'it reuses the existing checkbox style, not a new one');
});

/* ---------------- the context-usage readout (C) ---------------- */

test('the context-usage readout reports a percentage of the window and labels itself an estimate', () => {
  const h = helpers();
  assert.equal(typeof h.estimateTextTokens, 'function', 'the token estimate is a real function');
  assert.equal(h.estimateTextTokens(''), 0, 'empty text costs nothing');
  assert.equal(h.estimateTextTokens('a'.repeat(100)), 25, '100 ASCII characters is 25 estimated tokens (4 chars/token)');
  const line = h.contextUsageLine(25_000, 100_000);
  assert.match(line, /\d+% of context used/, 'a percentage of the context window');
  assert.match(line, /estimate/i, 'labelled an estimate');
  assert.equal(line, '25% of context used (estimate)');
  assert.match(SRC, /contextUsageLine\(usedTokens, windowTokens\)/, 'the readout renders the line');
  assert.match(SRC, /estimated at four characters per token/, 'the readout explains how the estimate is made');
});
