import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/test/mascot.test.js -> repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = (n: string) => join(ROOT, 'ui', 'src', 'mascot', 'data', `${n}.json`);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const BOTS = ['archivist', 'assayer', 'builder', 'exorcist', 'forgemaster', 'herald', 'inquisitor', 'preceptor', 'scout', 'scribe', 'sculptor', 'sentinel'];

// ---- golden rule 1: the Relic is byte-identical ----
const RELIC_SHA = '7f7b1ea5adfa1a528acf25982640a10a278ce924a68d6fb702907ad26cbf71b8';
const RELIC_CSS_SHA = 'f0f053bd3bbec2a4c93df39ee8e90bc687b9641e45c76f312b2c62b22d19217b'; // first 10387 bytes of mascot.css
const RELIC_TSX_SHA = 'd8ad7f773499273e3009';

test('relic.json is byte-identical to the approved build', () => {
  assert.equal(sha(readFileSync(data('relic'))), RELIC_SHA);
});

test('the Relic stylesheet and stage are untouched (new rules are appended only)', () => {
  const css = readFileSync(join(ROOT, 'ui', 'src', 'mascot', 'mascot.css'));
  assert.equal(sha(css.subarray(0, 10387)), RELIC_CSS_SHA);
  assert.ok(sha(readFileSync(join(ROOT, 'ui', 'src', 'mascot', 'Relic.tsx'))).startsWith(RELIC_TSX_SHA));
});

const py = spawnSync('python3', ['--version']);
test('build-mascot.py regenerates every committed json byte for byte (relic included)', { skip: py.status !== 0 && 'python3 not available' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legion-mascot-'));
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    cpSync(join(ROOT, 'scripts', 'build-mascot.py'), join(tmp, 'scripts', 'build-mascot.py'));
    cpSync(join(ROOT, 'docs', 'art', 'muster'), join(tmp, 'docs', 'art', 'muster'), { recursive: true });
    const r = spawnSync('python3', ['scripts/build-mascot.py', '--all'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const n of ['relic', ...BOTS]) {
      const fresh = readFileSync(join(tmp, 'ui', 'src', 'mascot', 'data', `${n}.json`));
      assert.equal(sha(fresh), sha(readFileSync(data(n))), `${n}.json is stale: run python3 scripts/build-mascot.py --all`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- contract ----
interface Layer { id: string; markup: string; pivot: number[] | null; alarm?: number[]; flip?: string }
interface Built { name: string; crop: number[]; cropRail?: number[]; defs: string; layers: Layer[] }
const load = (n: string) => JSON.parse(readFileSync(data(n), 'utf8')) as Built;

test('every bust meets the layer contract and carries a rail crop', () => {
  for (const n of BOTS) {
    const b = load(n);
    const ids = b.layers.map((l) => l.id);
    for (const need of ['L-aura', 'L-halo-back', 'L-plume', 'L-helm', 'L-face', 'L-front']) assert.ok(ids.includes(need), `${n} lacks ${need}`);
    const hangs = ids.filter((i) => i.startsWith('L-hang-')).length;
    assert.ok(hangs >= 3 && hangs <= 8, `${n}: ${hangs} hangs`);
    assert.ok(ids.filter((i) => i.startsWith('L-token-')).length <= 3);
    assert.ok(b.cropRail && b.cropRail.length === 4 && b.cropRail[2] > 0 && b.cropRail[3] > 0, `${n} has no cropRail`);
    const face = b.layers.find((l) => l.id === 'L-face')!.markup;
    for (const set of ['base', 'narrow', 'happy', 'wince', 'shut', 'angry']) assert.ok(face.includes(`xe-${set}`), `${n} lacks eye set ${set}`);
    assert.ok(face.includes('x-code'), `${n} lacks the code scroll`);
    // the 4 px eye grid: every eye cell is a 4x4 rect
    const cells = [...face.matchAll(/<rect x="[^"]+" y="[^"]+" width="(\d+)" height="(\d+)"/g)].filter((m) => m[1] === '4' || m[2] === '4');
    assert.ok(cells.length >= 20, `${n}: eyes missing`);
  }
});

test('ids are unique inside a bust and never shared between busts (several can live on one page)', () => {
  const owner = new Map<string, string>();
  for (const n of ['relic', ...BOTS]) {
    const b = load(n);
    const seen = new Set<string>();
    for (const src of [b.defs, ...b.layers.map((l) => l.markup)]) {
      for (const m of src.matchAll(/\bid="([^"]+)"/g)) {
        assert.ok(!seen.has(m[1]), `${n}: duplicate id ${m[1]}`);
        seen.add(m[1]);
        assert.ok(!owner.has(m[1]) || owner.get(m[1]) === n, `id ${m[1]} used by ${owner.get(m[1])} and ${n}`);
        owner.set(m[1], n);
      }
    }
  }
});

test('declared art extras reach the json (flip, alarm, badge, vm)', () => {
  const tok = load('scribe').layers.find((l) => l.id === 'L-token-1')!;
  assert.deepEqual(tok.alarm, [388, 380]);
  assert.equal(tok.flip, 'none');
  assert.deepEqual((load('assayer') as Built & { badge?: number[] }).badge, [430, 330]);
  assert.deepEqual((load('builder') as Built & { vm?: number[] }).vm, [418, 236]);
});

// ---- personas ----
interface Step { p: string; target?: string; targets?: string | string[] }
interface Persona { name: string; quips: string[]; annoyedQuip?: string; tempo?: number; verbs?: Array<{ id: string; w?: number; cd?: number; when?: string; steps: Step[] }> }
const PRIM = new Set(['lean', 'nod', 'scan', 'flutter', 'flare', 'wave']);

test('personas: quips, annoyed line, tempo, and verbs built only from the shared primitives on layers that exist', () => {
  const dir = join(ROOT, 'ui', 'src', 'mascot', 'personas');
  assert.deepEqual(readdirSync(dir).sort(), ['zealot', ...BOTS].sort().map((n) => `${n}.json`));
  for (const n of ['zealot', ...BOTS]) {
    const p = JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8')) as Persona;
    assert.equal(p.quips.length, n === 'zealot' ? 14 : 12, `${n} quips`);
    assert.equal(new Set(p.quips).size, p.quips.length, `${n}: duplicate quip`);
    assert.ok(p.annoyedQuip, `${n} annoyed quip`);
    if (p.tempo !== undefined) assert.ok(p.tempo >= 0.7 && p.tempo <= 1.5, `${n} tempo`);
    const layers = new Set(load(n === 'zealot' ? 'relic' : n).layers.map((l) => l.id));
    const has = (t: string) => {
      if (['rig', 'halo', 'hangs', 'token', 'plume', 'helm', 'face'].includes(t)) return true;
      const r = /^(hang|token)-(\d+)(?:\.\.(\d+))?$/.exec(t);
      if (!r) return false;
      for (let i = +r[2]; i <= +(r[3] ?? r[2]); i++) if (!layers.has(`L-${r[1]}-${i}`)) return false;
      return true;
    };
    assert.ok((p.verbs?.length ?? 0) >= 3, `${n} verbs`);
    for (const v of p.verbs ?? []) {
      assert.ok((v.w ?? 1) > 0 && (v.cd ?? 30) >= 0, `${n}/${v.id} weight or cooldown`);
      assert.ok(!v.when || ['idle', 'quip', 'victory'].includes(v.when));
      for (const s of v.steps) {
        assert.ok(PRIM.has(s.p), `${n}/${v.id}: unknown primitive ${s.p}`);
        for (const t of [s.target, ...(Array.isArray(s.targets) ? s.targets : [s.targets])]) if (t) assert.ok(has(t), `${n}/${v.id}: no layer ${t}`);
      }
    }
  }
});

test('docs: every bot ships its layered svg, portrait and notes', () => {
  for (const n of BOTS) for (const f of [`${n}.layered.svg`, `${n}.portrait.svg`, 'notes.md']) assert.ok(existsSync(join(ROOT, 'docs', 'art', 'muster', n, f)), `${n}/${f}`);
});
