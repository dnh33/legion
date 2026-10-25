// test/claude-own-checks-fix3.test.ts: fix round A+B 3 for "Claude agents follow Claude's own permission checks" (0.3.6).
// N1: a catastrophic command whose own words are spread over thousands of blanks is still found; a heredoc body is data; the cost stays linear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { longCatastrophic, MAX_READABLE } from '../src/core/exec/shell-floor.js';

const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};

const PRESETS: Array<[string, Parameters<typeof gatesRig>[0]]> = [
  ['Full', { preset: 'bypass', follow: true }],
  ['Smart', { app: 'smart', follow: true }],
  ['Ask', { own: 'ask' }],
  ['Accept edits', { own: 'auto-edits' }],
];

// ------------------------------------------------------------------ N1: padding inside the command

const SPACE = ' '.repeat(11_000);
const SPREAD: Array<[string, string]> = [
  ['rm -rf spread over blanks', `rm -rf${SPACE}/`],
  ['rm -rf spread over a thousand files', `rm -rf ${Array.from({ length: 1000 }, (_, i) => `file${i}.txt`).join(' ')} /`],
  ['chmod -R 777 spread over blanks', `chmod -R 777${SPACE}/`],
  ['dd to a disk, blanks inside', `dd if=/dev/zero${SPACE}of=/dev/sda`],
  ['rm -rf spread over tabs and continuations', `rm -rf${'\t \\\n  '.repeat(2_500)}/`],
];
const HEREDOC_30K = `cat > notes.txt <<'EOF'\n${'x'.repeat(30_000)}\nEOF`;

test('N1: longCatastrophic finds a catastrophic command whose own words are spread over thousands of blanks', () => {
  for (const [name, c] of SPREAD) {
    assert.ok(c.length > MAX_READABLE, name);
    const hit = longCatastrophic(c, 'sh');
    // once its blanks are collapsed the command fits one window and is found; a thousand file names do not, and that statement is "too long to read"
    assert.equal(hit?.kind, name.includes('thousand files') ? 'unread' : 'found', name);
  }
  const ps = `Remove-Item -Recurse -Force${SPACE}C:\\`;
  assert.equal(longCatastrophic(ps, 'pwsh')?.kind, 'found', 'PowerShell');
});

test('N1: a heredoc body is data: out of the scan and out of the length count', () => {
  assert.equal(longCatastrophic(HEREDOC_30K, 'sh'), undefined);
  assert.equal(longCatastrophic(`cat > a.md <<EOF\n${'rm -rf /\n'.repeat(2_000)}EOF\necho done`, 'sh'), undefined, 'text in a body that only a file receives');
  assert.equal(longCatastrophic(`cat <<-"END" > f\n${'\tordinary line\n'.repeat(1_000)}\tEND\n`, 'sh'), undefined, '<<- with a quoted word');
  // the text after a body is read again
  assert.equal(longCatastrophic(`${HEREDOC_30K}\nrm -rf /`, 'sh')?.kind, 'found');
  // a body fed to a shell is code: it stays in the scan
  assert.equal(longCatastrophic(`bash <<EOF\n${'echo hi\n'.repeat(2_000)}rm -rf /\nEOF`, 'sh')?.kind, 'found');
  assert.equal(longCatastrophic(`cat <<EOF | sh\n${'echo hi\n'.repeat(2_000)}rm -rf /\nEOF`, 'sh')?.kind, 'found');
  // PowerShell here-string
  assert.equal(longCatastrophic(`$t = @'\n${'y'.repeat(30_000)}\n'@\nSet-Content a.txt $t`, 'pwsh'), undefined);
});

test('N1: a "<<" that is not a heredoc cannot hide the lines after it', () => {
  const pad = `echo ${'A'.repeat(12_000)}`;
  assert.equal(longCatastrophic(`echo "<<EOF"\nrm -rf /\nEOF\n${pad}`, 'sh')?.kind, 'found', 'inside quotes');
  assert.equal(longCatastrophic(`echo $((1<<X))\nrm -rf /\nX\n${pad}`, 'sh')?.kind, 'found', 'inside arithmetic');
  assert.equal(longCatastrophic(`echo a <<EOF\nrm -rf /\n${pad}`, 'sh')?.kind, 'found', 'a heredoc that never ends is not trusted');
});

test('N1: a shape that spans statements (a fork bomb) is found wherever the groups of statements break', () => {
  const bomb = ':(){ :|:& };:';
  const line = `echo ${'z'.repeat(93)}\n`;
  for (let before = 3_000; before <= 11_000; before += 53) {
    const c = `${line.repeat(Math.ceil(before / line.length))}${bomb}\n${line.repeat(120)}`;
    assert.equal(longCatastrophic(c, 'sh')?.kind, 'found', `after ${before} characters of lines`);
  }
  const split = `${line.repeat(60)}:(){ :|:& }\n;\n:\n${line.repeat(120)}`;
  assert.equal(longCatastrophic(split, 'sh')?.kind, 'found', 'written over three lines');
});

test('N1: heredoc words that never close, and a flood of openers, cost no more than a few passes', () => {
  const shapes: Array<[string, string]> = [
    ['8,000 openers', '<<-EOF\n\t'.repeat(8_000)],
    ['distinct words', Array.from({ length: 4_000 }, (_, i) => `cat <<W${i}`).join('\n')],
    ['here-string openers', "@'\n".repeat(20_000)],
  ];
  for (const [name, c] of shapes) {
    const t = performance.now();
    longCatastrophic(c, name.startsWith('here') ? 'pwsh' : 'sh');
    assert.ok(performance.now() - t < 400, `${name}: ${Math.round(performance.now() - t)} ms`);
  }
});

test('N1: one statement still longer than the scan window after collapsing is "too long to read"; many short lines are not', () => {
  const one = longCatastrophic(`echo ${'word '.repeat(2_500)}`, 'sh');
  assert.equal(one?.kind, 'unread');
  const many = longCatastrophic(`${'echo some ordinary line\n'.repeat(1_200)}`, 'sh');
  assert.equal(many, undefined);
  assert.equal(longCatastrophic(`echo "${'a; b '.repeat(1_500)}"`, 'sh')?.kind, 'unread', 'separators inside quotes do not split');
});

test('N1: time stays linear: 64,000 and 1,000,000 characters', () => {
  const shapes: Array<[string, string]> = [
    ['64k spaces', `rm -rf${' '.repeat(64_000)}x`],
    ['64k lines', 'echo hi\n'.repeat(8_000)],
    ['64k heredoc', `cat <<EOF\n${'line of text\n'.repeat(5_000)}EOF`],
    ['64k backslashes', '\\'.repeat(63_999)],
    ['64k quotes', `"${"'".repeat(63_990)}"`],
    ['64k semicolons', ';'.repeat(63_999)],
    ['64k parens', '$('.repeat(31_990)],
    ['1 MB heredoc', `cat <<EOF\n${'a perfectly ordinary line\n'.repeat(40_000)}EOF`],
    ['1 MB one line', `echo ${'x '.repeat(500_000)}`],
    ['1 MB lines', 'echo hi\n'.repeat(130_000)],
    ['1 MB blanks', `rm -rf${' '.repeat(1_000_000)}/`],
  ];
  for (const [name, c] of shapes) {
    // best of three: a busy machine slows one run, never all three. Backtracking that is not linear takes seconds to
    // forever, so a budget this wide still catches it and a loaded runner no longer turns the gate red.
    let ms = Infinity;
    for (let k = 0; k < 3; k++) { const t = performance.now(); longCatastrophic(c, 'sh'); ms = Math.min(ms, performance.now() - t); }
    assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`);
  }
});

test('N1: each spread-out command gets one card for a Claude agent in Full, Smart, Ask and Accept edits, and a No denies', async () => {
  for (const [preset, rig] of PRESETS) {
    for (const [name, command] of SPREAD) {
      await using({ ...rig, ownChecks: true }, async (r) => {
        const h = await r.hookAll('Bash', { command });
        assert.deepEqual([h.cards, h.decision], [1, 'deny'], `${preset}: ${name}`);
      });
    }
  }
});

test('N1: a 30,000-character heredoc body gets no card in any preset', async () => {
  for (const [preset, rig] of PRESETS) {
    await using({ ...rig, ownChecks: true }, async (r) => {
      const h = await r.hookAll('Bash', { command: HEREDOC_30K });
      assert.deepEqual([h.cards, h.decision], [0, undefined], preset);
    });
  }
});

// ------------------------------------------------------------------ N2: Full, Windows deletes of the project folder
