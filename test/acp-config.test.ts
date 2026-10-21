/** Agent host settings: entries, the four in-between switches (off), watchdog minutes, first-use flag. */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/core/bus.js';
import { SettingsError, SettingsService, validatePatch } from '../src/core/settings.js';
import { defaultConfig, normalizeAcp } from '../src/shared/config.js';
import { acpEntry, BUILTIN_HERMES, buildAcpView, containedArgs, entryLimits } from '../src/shared/acp-view.js';
import type { AcpEntry } from '../src/shared/acp-view.js';

const SWITCHES_OFF = { disasterStop: false, modeMap: false, stripSkipFlags: false, answerOnce: false };

function svcOn(disk: unknown = { port: 4747 }) {
  const dir = cleanupTemp('legion-acp-');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(disk));
  const config = defaultConfig();
  const svc = new SettingsService({ config, bus: new EventBus(), configPath: file, dataDir: dir });
  return { svc, config, file };
}

test('a fresh config has the Hermes entry, all four switches off, 10 minutes, first use not seen', () => {
  const acp = defaultConfig().acp;
  assert.deepEqual(acp.entries, [BUILTIN_HERMES]);
  assert.deepEqual(BUILTIN_HERMES, { id: 'hermes', label: 'Hermes', command: 'hermes', args: ['acp'], tested: true, enabled: true });
  assert.deepEqual(acp.switches, SWITCHES_OFF);
  assert.equal(acp.watchdogMinutes, 10);
  assert.equal(acp.firstUseSeen, false);
  assert.deepEqual(normalizeAcp(undefined), acp, 'a config with no acp block reads as the defaults');
  assert.deepEqual(normalizeAcp('junk'), acp);
});

test('watchdogMinutes clamps to 1..120 and falls back to 10 when it is not a number', () => {
  assert.equal(normalizeAcp({ watchdogMinutes: 0 }).watchdogMinutes, 1);
  assert.equal(normalizeAcp({ watchdogMinutes: -5 }).watchdogMinutes, 1);
  assert.equal(normalizeAcp({ watchdogMinutes: 500 }).watchdogMinutes, 120);
  assert.equal(normalizeAcp({ watchdogMinutes: 7.6 }).watchdogMinutes, 8);
  assert.equal(normalizeAcp({ watchdogMinutes: 30 }).watchdogMinutes, 30);
  assert.equal(normalizeAcp({ watchdogMinutes: '30' }).watchdogMinutes, 10);
  assert.equal(normalizeAcp({ watchdogMinutes: NaN }).watchdogMinutes, 10);
});

test('switches: only a literal true turns one on; unknown keys are dropped everywhere', () => {
  const n = normalizeAcp({
    switches: { disasterStop: true, modeMap: 'yes', stripSkipFlags: 1, answerOnce: true, extra: true },
    firstUseSeen: 'true', surprise: 1,
  });
  assert.deepEqual(n.switches, { disasterStop: true, modeMap: false, stripSkipFlags: false, answerOnce: true });
  assert.equal(n.firstUseSeen, false);
  assert.deepEqual(Object.keys(n).sort(), ['entries', 'firstUseSeen', 'switches', 'watchdogMinutes']);
  assert.equal(normalizeAcp({ firstUseSeen: true }).firstUseSeen, true);
});

test('entry ids must match the id rule and may not be claude; bad ones are dropped', () => {
  const ok = { command: 'goose', args: ['acp'] };
  const n = normalizeAcp({ entries: [
    { id: 'goose', ...ok }, { id: 'claude', ...ok }, { id: 'Bad', ...ok }, { id: 'a', ...ok }, { id: '1x', ...ok }, { id: 'x'.repeat(33), ...ok }, { id: 'ok-id-2', ...ok },
  ] });
  assert.deepEqual(n.entries.map((e) => e.id), ['hermes', 'goose', 'ok-id-2']);
});

test('the built-in entry is always there and its command cannot be changed by the file', () => {
  const n = normalizeAcp({ entries: [{ id: 'hermes', label: 'Mine', command: 'evil', args: ['x'], tested: false, enabled: false, contained: true }] });
  assert.equal(n.entries.length, 1);
  assert.deepEqual(n.entries[0], { ...BUILTIN_HERMES, enabled: false, contained: true }, 'only enabled and contained come from the file');
  assert.deepEqual(normalizeAcp({ entries: [] }).entries, [BUILTIN_HERMES], 'a file that drops Hermes gets it back');
});

test('a custom entry is forced untested, cannot be contained, and gets no Legion tools and no Full', () => {
  const n = normalizeAcp({ entries: [{ id: 'goose', label: 'Goose', command: 'goose', args: ['acp'], env: { A: 'b', C: 3 }, tested: true, enabled: true, contained: true }] });
  const goose = n.entries.find((e) => e.id === 'goose')!;
  assert.equal(goose.tested, false);
  assert.equal(goose.contained, undefined);
  assert.deepEqual(goose.env, { A: 'b' }, 'non-string env values are dropped');
  assert.deepEqual(entryLimits(goose), { legionTools: false, fullAllowed: false });
  assert.deepEqual(entryLimits(BUILTIN_HERMES), { legionTools: true, fullAllowed: true });
});

test('a custom entry without a usable command is dropped; an enabled flag defaults to false for custom entries', () => {
  const n = normalizeAcp({ entries: [
    { id: 'nocmd', args: [] }, { id: 'blank', command: '  ' }, { id: 'ctl', command: 'a\nb' }, { id: 'fine', command: 'tool' },
    { id: 'badargs', command: 'tool', args: ['ok', 5] },
  ] });
  assert.deepEqual(n.entries.map((e) => e.id), ['hermes', 'fine']);
  assert.equal(n.entries[1]!.enabled, false, 'a new custom entry starts switched off until the owner turns it on');
});

test('containedArgs adds the legion profile when contained', () => {
  assert.deepEqual(containedArgs(BUILTIN_HERMES), ['acp']);
  assert.deepEqual(containedArgs({ ...BUILTIN_HERMES, contained: true }), ['-p', 'legion', 'acp']);
});

test('acpEntry looks an entry up by id in a config', () => {
  const cfg = defaultConfig();
  assert.deepEqual(acpEntry(cfg, 'hermes'), BUILTIN_HERMES);
  assert.equal(acpEntry(cfg, 'nope'), undefined);
  assert.deepEqual(acpEntry({}, 'hermes'), BUILTIN_HERMES, 'a config with no acp block still knows the built-in entry');
  assert.equal(acpEntry({}, 'goose'), undefined);
});

test('the view lists entries with their limits, detection and no env values', () => {
  const entries: AcpEntry[] = [BUILTIN_HERMES, { id: 'goose', label: 'Goose', command: 'goose', args: [], env: { TOKEN: 'secret' }, tested: false, enabled: true }];
  const v = buildAcpView({ ...defaultConfig().acp, entries });
  assert.deepEqual(v.switches, SWITCHES_OFF);
  assert.equal(v.watchdogMinutes, 10);
  assert.equal(v.entries[0]!.detection.state, 'unknown');
  assert.deepEqual(v.entries[1]!.envKeys, ['TOKEN']);
  assert.equal(JSON.stringify(v).includes('secret'), false);
  assert.deepEqual([v.entries[0]!.legionTools, v.entries[0]!.fullAllowed, v.entries[1]!.legionTools, v.entries[1]!.fullAllowed], [true, true, false, false]);
  const d = buildAcpView({ ...defaultConfig().acp, entries }, () => ({ state: 'found', version: '0.23.0' }));
  assert.deepEqual(d.entries[1]!.detection, { state: 'found', version: '0.23.0' });
});

test('a Settings patch flips each switch, contained, the watchdog and first use, and it is on disk afterwards', () => {
  const { svc, config, file } = svcOn();
  for (const k of Object.keys(SWITCHES_OFF) as Array<keyof typeof SWITCHES_OFF>) {
    const v = svc.patch({ acp: { switches: { [k]: true } } });
    assert.equal(v.acp.switches[k], true, k);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.acp.switches[k], true, `${k} persisted`);
  }
  assert.deepEqual(config.acp.switches, { disasterStop: true, modeMap: true, stripSkipFlags: true, answerOnce: true });
  let v = svc.patch({ acp: { switches: { modeMap: false } } });
  assert.deepEqual(v.acp.switches, { disasterStop: true, modeMap: false, stripSkipFlags: true, answerOnce: true }, 'omitted switches are unchanged');
  v = svc.patch({ acp: { entries: [{ id: 'hermes', contained: true }], watchdogMinutes: 25, firstUseSeen: true } });
  assert.equal(v.acp.entries[0]!.contained, true);
  assert.equal(v.acp.watchdogMinutes, 25);
  assert.equal(v.acp.firstUseSeen, true);
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.port, 4747, 'the rest of the file is untouched');
  assert.equal(disk.acp.entries.find((e: AcpEntry) => e.id === 'hermes').contained, true);
  assert.deepEqual(containedArgs(acpEntry(config, 'hermes')!), ['-p', 'legion', 'acp']);
  v = svc.patch({ acp: { entries: [{ id: 'hermes', contained: false }] } });
  assert.equal(v.acp.entries[0]!.contained, false);
  v = svc.patch({ claude: { maxTurns: 9 } });
  assert.equal(v.acp.watchdogMinutes, 25, 'a patch without acp leaves it alone');
});

test('a Settings patch adds a custom entry (untested, off, no Hermes-only powers) and removes it again', () => {
  const { svc, config } = svcOn();
  let v = svc.patch({ acp: { entries: [{ id: 'goose', label: 'Goose', command: 'goose', args: ['acp'], tested: true, contained: true, enabled: true }] } });
  const goose = v.acp.entries.find((e) => e.id === 'goose')!;
  assert.equal(goose.tested, false);
  assert.equal(goose.contained, undefined);
  assert.equal(goose.enabled, true);
  assert.deepEqual([goose.legionTools, goose.fullAllowed], [false, false]);
  assert.equal(entryLimits(acpEntry(config, 'goose')!).fullAllowed, false);
  v = svc.patch({ acp: { entries: [{ id: 'goose', enabled: false }] } });
  assert.equal(v.acp.entries.find((e) => e.id === 'goose')!.command, 'goose', 'a partial entry keeps what it did not name');
  v = svc.patch({ acp: { remove: ['goose', 'hermes'] } });
  assert.deepEqual(v.acp.entries.map((e) => e.id), ['hermes'], 'a custom entry can be removed; the built-in one cannot');
});

test('a bad acp patch is a 400 and stores nothing', () => {
  const { svc, config, file } = svcOn();
  const before = readFileSync(file, 'utf8');
  const bad: unknown[] = [
    { acp: 'x' }, { acp: { switches: { modeMap: 'on' } } }, { acp: { watchdogMinutes: 0 } }, { acp: { watchdogMinutes: 121 } },
    { acp: { watchdogMinutes: 'ten' } }, { acp: { firstUseSeen: 1 } }, { acp: { entries: 'x' } }, { acp: { entries: [{ id: 'claude', command: 'x' }] } },
    { acp: { entries: [{ id: 'Bad Id', command: 'x' }] } }, { acp: { entries: [{ id: 'new-one' }] } }, { acp: { entries: [{ id: 'g', command: '' }] } },
    { acp: { entries: [{ id: 'goose', command: 'g', args: [1] }] } }, { acp: { remove: 'goose' } },
  ];
  for (const b of bad) assert.throws(() => svc.patch(b), (e) => e instanceof SettingsError && e.status === 400, JSON.stringify(b));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(config.acp, defaultConfig().acp);
});

test('unknown keys in a patch are dropped', () => {
  assert.deepEqual(validatePatch({ acp: { switches: { nope: true } } }).acp, { switches: {} });
  const p = validatePatch({ acp: { switches: { answerOnce: true }, hack: 1, entries: [{ id: 'hermes', enabled: false, command: 'evil', extra: 1 }] } });
  assert.deepEqual(p.acp, { switches: { answerOnce: true }, entries: [{ id: 'hermes', enabled: false, command: 'evil' }] });
  const { svc } = svcOn();
  const v = svc.patch({ acp: { entries: [{ id: 'hermes', enabled: false, command: 'evil' }] } });
  assert.equal(v.acp.entries[0]!.command, 'hermes', 'the built-in command still cannot be changed');
  assert.equal(v.acp.entries[0]!.enabled, false);
});
