/**
 * The Electron migration guard. Electron is Legion's runtime on Windows (the window, and the core in a package install), so a new
 * Electron is a migration, not a dependency bump: every agent that changes it must read Electron's own release notes for every
 * version crossed (and the breaking-changes guide for every major crossed), check the Legion code those notes touch, and write
 * that down in docs/electron-upgrades.json. This test fails until the record matches the pin. How to write the record:
 * .claude/skills/upgrading-electron/SKILL.md. `node scripts/electron-upgrade.mjs --check` (CI) also checks the version list
 * against the npm registry, which this offline test cannot reach.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface VersionNote { version: string; notes: string; evidence: string; affects: string }
interface Upgrade { from: string; to: string; date: string; why: string; versions: VersionNote[]; majorsCrossed: Array<{ major: number; guide: string; checked: string }>; apisChecked: Array<{ api: string; where: string; verdict: string }>; checks: string[]; review?: { by: string; reread: string[]; verdict: string } }
interface UpgradeRecord { floor: { version: string; reason: string; source: string }; upgrades: Upgrade[] }
// The checker is plain JS so the CI step can run it without a build; the shapes above are its contract.
const { checkRecord, cmpVersion } = (await import(new URL('../../scripts/lib/electron-upgrade-record.mjs', import.meta.url).href)) as {
  checkRecord(record: UpgradeRecord, pin: string, exists: (repoPath: string) => boolean): string[];
  cmpVersion(a: string, b: string): number;
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const pkg = json('package.json') as { devDependencies: Record<string, string> };
const lock = json('package-lock.json') as { packages: Record<string, { version?: string; devDependencies?: Record<string, string> }> };
const record = json('docs/electron-upgrades.json') as UpgradeRecord;
const pin = pkg.devDependencies.electron!;

describe('Electron migration guard', () => {
  it('pins Electron to one exact version, and the lock installs that version', () => {
    assert.match(pin, /^\d+\.\d+\.\d+$/, `package.json must pin electron exactly (no ^ or ~), got ${pin}`);
    assert.equal(lock.packages['']?.devDependencies?.electron, pin, 'package-lock.json root entry');
    assert.equal(lock.packages['node_modules/electron']?.version, pin, 'package-lock.json resolves a different electron');
  });

  it('never ships below the security floor', () => {
    assert.ok(cmpVersion(pin, record.floor.version) >= 0, `electron ${pin} is below the floor ${record.floor.version}: ${record.floor.reason}`);
  });

  it('has an upgrade record for the pinned version that cites the official sources', () => {
    const problems = checkRecord(record, pin, (p) => existsSync(join(root, p)));
    assert.deepEqual(problems, []);
  });

  it('rejects a record that skips a version, a major, an API check or a source', () => {
    const good = record.upgrades.at(-1)!;
    const bad = (patch: Partial<typeof good>, to = pin) => checkRecord({ ...record, upgrades: [...record.upgrades.slice(0, -1), { ...good, ...patch }] }, to, () => true);
    assert.ok(bad({}, '45.0.0').some((p) => /no upgrade record ends at 45\.0\.0/.test(p)), 'a bump without a record');
    assert.ok(bad({ versions: good.versions.slice(0, -1) }).some((p) => /last version/.test(p)), 'the target version itself left out');
    assert.ok(bad({ versions: good.versions.map((v) => ({ ...v, notes: 'https://example.test/notes' })) }).some((p) => /official release notes/.test(p)), 'a non-official source');
    assert.ok(bad({ versions: good.versions.map((v) => ({ ...v, affects: ' ' })) }).some((p) => /what it means for Legion/.test(p)), 'notes cited but not read against Legion');
    assert.ok(bad({ versions: good.versions.map((v) => ({ ...v, evidence: '' })) }).some((p) => /evidence/.test(p)), 'no line copied from the notes');
    assert.ok(bad({ versions: good.versions.map((v) => ({ ...v, affects: 'x' })) }).some((p) => /20\+ characters/.test(p)), 'a one-letter reading');
    assert.ok(bad({ apisChecked: [] }).some((p) => /apisChecked/.test(p)), 'no Legion API checked');
    assert.ok(bad({ review: undefined }).some((p) => /review needs/.test(p)), 'nobody re-read it');
    assert.ok(bad({ review: { by: 'a second reader', reread: ['44.6.0'], verdict: 'agreed with every line read' } }).some((p) => /review needs/.test(p)), 'one version re-read is not enough');
    assert.ok(bad({ review: { by: 'a second reader', reread: ['44.6.0', '43.0.0'], verdict: 'agreed with every line read' } }).some((p) => /review needs/.test(p)), 'a version outside the upgrade');
    assert.ok(bad({ from: '43.0.0', versions: [{ version: '44.9.3', notes: 'https://github.com/electron/electron/releases/tag/v44.9.3', evidence: 'commit c542df1ecb', affects: 'upstream security backports only' }] }).some((p) => /major 44/.test(p)), 'a major crossed without the breaking-changes guide');
    assert.ok(bad({ versions: [{ version: '44.9.3-beta.1', notes: 'https://github.com/electron/electron/releases/tag/v44.9.3-beta.1', evidence: 'commit c542df1ecb', affects: 'upstream security backports only' }] }).some((p) => /stable/.test(p)), 'a prerelease');
  });
});
