/** The live walk (.github/workflows/live-walk.yml) passes an install through the stepping stone when it is older than the stone. These pin the hop plan. */
import test from 'node:test';
import assert from 'node:assert/strict';

const plan = await import(new URL('../../scripts/live-walk/plan.mjs', import.meta.url).href) as {
  planHops(a: { from: string; to: string; stone: string }): Array<{ version: string; manifest: string }>;
  compareVersions(a: string, b: string): number;
  isPlainVersion(v: unknown): boolean;
};

test('an install older than the stone goes to the stone, then to the newest release', () => {
  assert.deepEqual(plan.planHops({ from: '0.2.7', to: '0.3.1', stone: '0.3.0' }), [{ version: '0.3.0', manifest: 'old' }, { version: '0.3.1', manifest: 'second' }]);
});
test('walking to the stone itself is one hop on the old name', () => {
  assert.deepEqual(plan.planHops({ from: '0.2.7', to: '0.3.0', stone: '0.3.0' }), [{ version: '0.3.0', manifest: 'old' }]);
});
test('the stone goes straight to the newest release on the second name', () => {
  assert.deepEqual(plan.planHops({ from: '0.3.0', to: '0.3.1', stone: '0.3.0' }), [{ version: '0.3.1', manifest: 'second' }]);
});
test('versions compare by number, not text', () => {
  assert.equal(plan.compareVersions('0.3.10', '0.3.9'), 1);
  assert.deepEqual(plan.planHops({ from: '0.3.9', to: '0.3.10', stone: '0.3.0' }), [{ version: '0.3.10', manifest: 'second' }]);
});
test('a walk that goes nowhere or takes a bad version is refused', () => {
  assert.throws(() => plan.planHops({ from: '0.3.1', to: '0.3.1', stone: '0.3.0' }), /nothing to walk/);
  assert.throws(() => plan.planHops({ from: '0.3.1', to: '0.3.0', stone: '0.3.0' }), /nothing to walk/);
  assert.throws(() => plan.planHops({ from: '0.2.7; rm', to: '0.3.1', stone: '0.3.0' }), /plain version/);
  assert.equal(plan.isPlainVersion('0.2.5-o'), false);
});
