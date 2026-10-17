/**
 * The saved Claude Code listing (Task 9b). A successful listing is kept on disk. When a later listing fails, the Armory uses the saved
 * one (mode 'sdk-cached') so the skills the owner switched on keep applying. The disk is read only when there is no usable saved
 * listing. A fake SDK stands in for Claude Code: no test starts a real one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoveryLine, discoveryWarning, savedWhen, unmatchedNote } from '../src/shared/armory-view.js';
import type { SdkProbe, SdkSnapshot } from '../src/core/armory/handshake.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, md, mkAgent, writeFile } from './armory-rig.js';

const snap = (o: Partial<SdkSnapshot> = {}): SdkSnapshot => ({ skills: [], commands: [], plugins: [], modelMessages: 0, costUsd: 0, ...o });
const sk = (name: string, description = 'Thing.'): { name: string; description: string } => ({ name, description });

/** A plugin 'gone' whose folder does not exist: its skills are listed by name, with no file. */
const listing = (names: string[], commands: Array<{ name: string; description: string }> = []): SdkSnapshot =>
  snap({ plugins: [{ name: 'gone', path: join(tempDir('legion-cchome-'), 'x') }], skills: names.map((n) => sk(n)), commands });

const failing: SdkProbe = async () => { throw new Error('Claude Code is not signed in'); };
const cachePath = (dataDir: string): string => join(dataDir, 'armory', 'sdk-listing.json');
const skillRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'gone:thing', name: 'thing', description: 'Thing.', source: 'claude-plugin', plugin: 'gone', path: null, manualOnlyInFrontmatter: false, ...over,
});
function savedListing(dataDir: string, over: Record<string, unknown> = {}): void {
  writeFile(cachePath(dataDir), JSON.stringify({ at: '2026-10-10T08:00:00.000Z', inherit: true, plugins: 1, skills: [skillRow()], cli: [], ...over }));
}

describe('a failed listing uses the saved one', () => {
  it('keeps every skill the owner switched on, reports the saved time and the failure, and claudeSkills still returns them', async () => {
    const link = { up: true };
    const r = armoryRig({ sdkProbe: async () => { if (!link.up) throw new Error('Claude Code is not signed in'); return listing(['gone:thing']); } });
    const first = await r.call('GET', '/api/armory');
    assert.equal(first.discovery, 'sdk');
    await r.call('POST', '/api/armory/state', { id: 'gone:thing', state: 'on' });
    link.up = false;
    const saved = JSON.parse(readFileSync(cachePath(r.dataDir), 'utf8')).at as string;
    const b = await r.call('POST', '/api/armory/refresh');
    assert.equal(b.discovery, 'sdk-cached');
    assert.equal(b.discoveredAt, saved, 'the screen shows the saved list\'s time, not the failed attempt');
    assert.equal(b.discoveryReason, `Using the skill list Claude Code gave on ${savedWhen(saved)}; the live listing failed: Claude Code is not signed in`);
    assert.ok(b.skills.some((s: any) => s.id === 'gone:thing'), 'the saved skill is in the list the screen shows');
    assert.equal(b.unmatchedOn, 0);
    assert.deepEqual(r.mod.claudeSkills!(r.agents.get('alpha')!).skills, ['gone:thing']);
  });

  it('with no saved listing, a failure reads the disk, and reports the switched-on skills no listing finds', async () => {
    const r = armoryRig({ sdkProbe: failing, cc: { personal: { mine: md('mine', 'Mine.') } } });
    writeFile(join(r.dataDir, 'armory', 'armory.json'), JSON.stringify({
      version: 1, migrations: ['cc-notice-v1'], ccNoticeSeen: true,
      skills: {
        mine: { state: 'on', source: 'claude-personal' },
        'design:ux-copy': { state: 'on', source: 'claude-plugin', plugin: 'design' },
        'engineering:debug': { state: 'on', source: 'claude-plugin', plugin: 'engineering' },
        'design:old': { state: 'off', source: 'claude-plugin', plugin: 'design' },
      },
    }));
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'disk-fallback');
    assert.equal(a.unmatchedOn, 2, 'the one that is on disk and the off one are not counted');
    assert.deepEqual(a.unmatchedOnIds, ['design:ux-copy', 'engineering:debug']);
  });

  it('a saved listing whose inherit switch differs is ignored', async () => {
    const r = armoryRig({ sdkProbe: failing });
    savedListing(r.dataDir, { inherit: false });
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'disk-fallback');
    assert.equal(a.skills.some((s: any) => s.id === 'gone:thing'), false);
  });

  it('a corrupt saved file is ignored', async () => {
    const r = armoryRig({ sdkProbe: failing });
    writeFile(cachePath(r.dataDir), '{"at": "2026-10-10T08:00:00.000Z", "inherit": tr');
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'disk-fallback');
  });

  it('a saved file over 2 MB is ignored', async () => {
    const r = armoryRig({ sdkProbe: failing });
    savedListing(r.dataDir, { skills: [skillRow({ description: 'x'.repeat(2_100_000) })] });
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'disk-fallback');
    assert.equal(a.skills.some((s: any) => s.id === 'gone:thing'), false);
  });

  it('drops the saved entries that are not valid and keeps the valid ones', async () => {
    const r = armoryRig({ sdkProbe: failing });
    savedListing(r.dataDir, {
      skills: [skillRow(), { id: 'gone:half' }, skillRow({ id: 'gone:bad-source', source: 'nope' }), skillRow({ id: 'gone:num', description: 5 }), 7],
    });
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'sdk-cached');
    assert.deepEqual(a.skills.map((s: any) => s.id).filter((id: string) => id.startsWith('gone:')), ['gone:thing']);
  });

  it('a later successful listing overwrites the saved one, and a failure after that uses the new one', async () => {
    const link = { up: true };
    let names = ['gone:first'];
    const r = armoryRig({ sdkProbe: async () => { if (!link.up) throw new Error('down'); return listing(names, [sk('zz-listed', 'A command.')]); } });
    await r.call('GET', '/api/armory');
    const onDisk = (): any => JSON.parse(readFileSync(cachePath(r.dataDir), 'utf8'));
    assert.deepEqual(onDisk().skills.map((s: any) => s.id), ['gone:first']);
    names = ['gone:second'];
    await r.call('POST', '/api/armory/refresh');
    assert.deepEqual(onDisk().skills.map((s: any) => s.id), ['gone:second'], 'the new listing replaced the saved one');
    assert.deepEqual(onDisk().cli, ['zz-listed']);
    assert.equal(onDisk().inherit, true);
    link.up = false;
    const c = await r.call('POST', '/api/armory/refresh');
    assert.equal(c.discovery, 'sdk-cached');
    assert.ok(c.skills.some((s: any) => s.id === 'gone:second'));
    assert.ok(!c.skills.some((s: any) => s.id === 'gone:first'));
  });
});

describe('a failed listing uses the saved one: what it may carry', () => {
  it('a planted entry of a source the live listing never makes is dropped, and never reaches the catalog, the file route or claudeSkills', async () => {
    const r = armoryRig({ sdkProbe: failing });
    const planted = join(r.home, 'planted', 'SKILL.md');
    writeFile(planted, md('planted', 'Planted by a process that can write the Armory folder.'));
    savedListing(r.dataDir, { skills: [
      skillRow({ id: 'planted:yours', name: 'yours', source: 'yours', path: planted, plugin: undefined }),
      skillRow({ id: 'planted:imported', name: 'imported', source: 'imported', path: planted, plugin: undefined }),
      skillRow({ id: 'gone:ok', name: 'ok' }),
    ] });
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.discovery, 'sdk-cached');
    const ids = a.skills.map((s: any) => s.id);
    assert.ok(ids.includes('gone:ok'), 'a valid claude entry is kept');
    assert.ok(!ids.includes('planted:yours') && !ids.includes('planted:imported'), 'the planted entries are dropped');
    assert.ok(!r.mod.catalog().some((e) => e.id.startsWith('planted:')), 'not in the catalog');
    await r.call('POST', '/api/armory/state', { id: 'gone:ok', state: 'on' });
    assert.deepEqual(r.mod.claudeSkills!(r.agents.get('alpha')!).skills, ['gone:ok']);
    await assert.rejects(() => r.call('GET', '/api/armory/file?id=planted:yours'), /No skill with the id/);
    await assert.rejects(() => r.call('GET', '/api/armory/file?id=planted:imported'), /No skill with the id/);
  });
});

describe('the sdk-cached slash path', () => {
  it('a saved Claude Code command is allowed for an agent that follows the Armory, and refused for one with its own list that does not name it', async () => {
    const link = { up: true };
    const r = armoryRig({
      sdkProbe: async () => { if (!link.up) throw new Error('down'); return listing(['gone:thing'], [sk('zz-listed', 'A command.')]); },
      agents: [mkAgent('alpha'), mkAgent('narrow', { skills: ['gone:thing'] })],
    });
    await r.call('GET', '/api/armory');
    link.up = false;
    const b = await r.call('POST', '/api/armory/refresh');
    assert.equal(b.discovery, 'sdk-cached');
    assert.equal(r.mod.refuseSlashCommand!(r.agents.get('alpha')!, '/zz-listed'), undefined);
    assert.match(r.mod.refuseSlashCommand!(r.agents.get('narrow')!, '/zz-listed') ?? '', /is not one of this agent's skills/);
    const slashAlpha = await r.call('GET', '/api/armory/slash?agent=alpha');
    assert.ok(!slashAlpha.refused.includes('zz-listed'));
    const slashNarrow = await r.call('GET', '/api/armory/slash?agent=narrow');
    assert.ok(slashNarrow.refused.includes('zz-listed'));
  });

  it('without a saved listing the same command is not a known command, so it is refused and the menu does not name it', async () => {
    const r = armoryRig({ sdkProbe: failing });
    assert.match(r.mod.refuseSlashCommand!(r.agents.get('alpha')!, '/zz-listed') ?? '', /is not a command Legion knows/);
    const slash = await r.call('GET', '/api/armory/slash?agent=alpha');
    assert.ok(!slash.refused.includes('zz-listed'));
  });
});

describe('the sdk-cached Discovery line and the Show which list', () => {
  it('the line gives the saved list\'s date and time, never "just now"', async () => {
    const r = armoryRig({ sdkProbe: failing });
    savedListing(r.dataDir, { at: new Date().toISOString() });
    const b = await r.call('GET', '/api/armory');
    assert.equal(b.discovery, 'sdk-cached');
    const line = discoveryLine(b, Date.now());
    assert.equal(line, `Using the skill list Claude Code gave on ${savedWhen(b.discoveredAt)}.`);
    assert.doesNotMatch(line, /just now|ago/);
  });

  it('overview lists the ids of switched-on skills that no listing finds, sorted, at most 50', async () => {
    const r = armoryRig({ sdkProbe: failing });
    const records: Record<string, unknown> = {};
    const ids: string[] = [];
    for (let i = 54; i >= 0; i--) {
      const id = `gone:skill-${String(i).padStart(2, '0')}`;
      ids.push(id);
      records[id] = { state: 'on', source: 'claude-plugin', plugin: 'gone' };
    }
    records['gone:off'] = { state: 'off', source: 'claude-plugin', plugin: 'gone' };
    writeFile(join(r.dataDir, 'armory', 'armory.json'), JSON.stringify({ version: 1, migrations: ['cc-notice-v1'], ccNoticeSeen: true, skills: records }));
    const a = await r.call('GET', '/api/armory');
    assert.equal(a.unmatchedOn, 55);
    assert.equal(a.unmatchedOnIds.length, 50);
    assert.deepEqual(a.unmatchedOnIds, [...ids].sort().slice(0, 50));
  });
});

describe('the Armory view of a saved or unmatched listing', () => {
  it('the warning shows the saved-listing reason for sdk-cached, and nothing when the switch is off', () => {
    const reason = 'Using the skill list Claude Code gave on 10 Oct 2026, 08:00; the live listing failed: Claude Code is not signed in';
    assert.equal(discoveryWarning({ inherit: true, discovery: 'sdk-cached', discoveryReason: reason }), `${reason}.`);
    assert.equal(discoveryWarning({ inherit: false, discovery: 'sdk-cached', discoveryReason: reason }), '');
  });

  it('the unmatched note is empty at zero, and reads correctly at one and at many', () => {
    assert.equal(unmatchedNote(0), '');
    assert.equal(unmatchedNote(1), '1 switched-on skill was not found in the current list, so agents do not get it.');
    assert.equal(unmatchedNote(2), '2 switched-on skills were not found in the current list, so agents do not get them.');
    assert.equal(unmatchedNote(68), '68 switched-on skills were not found in the current list, so agents do not get them.');
  });
});
