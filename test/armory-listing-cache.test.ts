/**
 * The saved Claude Code listing (Task 9b). A successful listing is kept on disk. When a later listing fails, the Armory uses the saved
 * one (mode 'sdk-cached') so the skills the owner switched on keep applying. The disk is read only when there is no usable saved
 * listing. A fake SDK stands in for Claude Code: no test starts a real one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { discoveryWarning, unmatchedNote } from '../src/shared/armory-view.js';
import type { SdkProbe, SdkSnapshot } from '../src/core/armory/handshake.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, md, writeFile } from './armory-rig.js';

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
  it('keeps every skill the owner switched on, reports the saved date and the failure, and claudeSkills still returns them', async () => {
    const link = { up: true };
    const r = armoryRig({ sdkProbe: async () => { if (!link.up) throw new Error('Claude Code is not signed in'); return listing(['gone:thing']); } });
    const first = await r.call('GET', '/api/armory');
    assert.equal(first.discovery, 'sdk');
    await r.call('POST', '/api/armory/state', { id: 'gone:thing', state: 'on' });
    link.up = false;
    const b = await r.call('POST', '/api/armory/refresh');
    assert.equal(b.discovery, 'sdk-cached');
    assert.match(b.discoveryReason, /^Using the skill list Claude Code gave on \d{4}-\d\d-\d\d; the live listing failed: Claude Code is not signed in$/);
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
    assert.equal(a.unmatchedOn, 2, 'two switched-on skills are not on disk; the one that is on disk and the off one are not counted');
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

describe('the Armory view of a saved or unmatched listing', () => {
  it('the warning shows the saved-listing reason for sdk-cached, and nothing when the switch is off', () => {
    const reason = 'Using the skill list Claude Code gave on 2026-10-10; the live listing failed: Claude Code is not signed in';
    assert.equal(discoveryWarning({ inherit: true, discovery: 'sdk-cached', discoveryReason: reason }),
      `${reason}.`);
    assert.equal(discoveryWarning({ inherit: false, discovery: 'sdk-cached', discoveryReason: reason }), '');
  });

  it('the unmatched note counts the skills, and is empty at zero', () => {
    assert.equal(unmatchedNote(0), '');
    assert.equal(unmatchedNote(68), '68 of your switched-on skills were not found in the current list, so agents do not get them.');
  });
});
