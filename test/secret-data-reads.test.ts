// test/secret-data-reads.test.ts: a read of Legion's own key files (provider keys, connector tokens, the gates key) is a secret read (final review I1):
// a card in Ask, Accept edits and Smart (no Remember), and every later web call in the run asks. Through the engine, not only the pure function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';
import { expandHomeWord, secretReadHit } from '../src/core/secret-paths.js';

// The fake data folder sits under the home folder, so `~/...` spellings reach it.
const DATA = join(homedir(), '.legion-secrettest');
const fwd = DATA.replace(/\\/g, '/');
const dataModule = { id: 'dataguard', protectedPaths: () => dataFolderTargets(DATA) } as never;

type Make = () => Promise<GatesRig>;
const RIGS: Array<[string, Make]> = [
  ['ask', () => gatesRig({ own: 'ask' })],
  ['auto-edits', () => gatesRig({ own: 'auto-edits' })],
  ['smart', () => gatesRig({ preset: 'smart', follow: true })],
];
async function withRig(make: Make, fn: (r: GatesRig) => Promise<void>): Promise<void> {
  const r = await make();
  r.engine.setModules([dataModule]);
  try { await fn(r); } finally { r.stop(); }
}
/** One call; a card (if any) is answered "no". */
async function ask(r: GatesRig, tool: string, input: Record<string, unknown>) {
  const p = r.call(tool, input); await r.tick();
  const pend = r.pending()[0];
  if (pend) r.answer(false);
  const d = await p;
  return { card: pend !== undefined, noRemember: pend?.noRemember === true, summary: pend?.summary ?? '', allow: d.allow };
}

const SECRET_READS: Array<[string, Record<string, unknown>]> = [
  ['Read', { file_path: `${fwd}/providers/keys.json` }],
  ['Read', { file_path: `${DATA}\\providers\\keys.enc` }],
  ['Read', { file_path: `${fwd}/providers/key.bin` }],
  ['Read', { file_path: `${fwd}/connectors/key.bin` }],
  ['Read', { file_path: `${fwd}/connectors/github.json` }],
  ['Read', { file_path: `${fwd}/gates-key.bin` }],
  ['Read', { file_path: `${fwd}/gates/app.json` }],
  ['mcp__host__read_file', { path: `${fwd}/providers/keys.json` }],
  ['Bash', { command: `cat ${fwd}/providers/keys.json` }],
  ['Bash', { command: 'cat ~/.legion-secrettest/providers/keys.json' }],
  ['Bash', { command: 'head -c 100 $HOME/.legion-secrettest/providers/keys.enc' }],
  ['PowerShell', { command: `Get-Content ${DATA}\\providers\\keys.json` }],
  ['PowerShell', { command: 'gc $env:USERPROFILE\\.legion-secrettest\\gates-key.bin' }],
  ['PowerShell', { command: 'type %USERPROFILE%\\.legion-secrettest\\connectors\\key.bin' }],
  ['mcp__host__shell', { command: `cat ${fwd}/connectors/key.bin` }],
  ['Grep', { pattern: 'sk-', path: `${fwd}/providers/keys.json` }],
  ['Grep', { pattern: 'sk-', path: `${fwd}/providers` }],
  ['Glob', { pattern: `${fwd}/providers/*` }],
  ['LS', { path: `${fwd}/connectors` }],
];

test('I1: Read, a shell reader and the search tools on Legion\'s key files card in Ask, Accept edits and Smart, with no Remember', async () => {
  for (const [mode, make] of RIGS) {
    await withRig(make, async (r) => {
      for (const [tool, input] of SECRET_READS) {
        const o = await ask(r, tool, input);
        assert.equal(o.card, true, `${mode}: ${tool} ${JSON.stringify(input)}`);
        assert.equal(o.noRemember, true, `${mode}: no Remember: ${tool}`);
        assert.match(o.summary, /^Legion wants to read .+\. It may hold passwords or keys\.$/, `${mode}: it is the secret-read card, not an ordinary one: ${tool}`);
        assert.equal(o.allow, false);
      }
    });
  }
});

test('I1: Bypass does not card (the one mode the owner chose to leave open)', async () => {
  await withRig(() => gatesRig({ own: 'full' }), async (r) => {
    for (const [tool, input] of SECRET_READS) { const o = await ask(r, tool, input); assert.equal(o.card, false, `${tool} ${JSON.stringify(input)}`); }
  });
});

test('I1: the rest of the data folder and ordinary files stay free to read', async () => {
  await withRig(() => gatesRig({ own: 'ask' }), async (r) => {
    // file tools are free to read in Ask, so a card here could only be the secret-read card
    for (const [tool, input] of [
      ['Read', { file_path: `${fwd}/config.json` }],
      ['Read', { file_path: `${fwd}/state.json` }],
      ['Read', { file_path: `${fwd}/workspaces/builder/keys.json` }],
      ['Read', { file_path: `${r.projectDir()}/keys.json` }],
      ['Read', { file_path: `${r.projectDir()}/providers/keys.json` }],
      ['Grep', { pattern: 'x', path: `${fwd}/logs` }],
      ['LS', { path: DATA }],
    ] as Array<[string, Record<string, unknown>]>) {
      const o = await ask(r, tool, input);
      assert.equal(o.card, false, `${tool} ${JSON.stringify(input)}`);
    }
  });
});

test('I1: the same shell readers on other paths are not secret reads (summary check on the guard itself)', async () => {
  await withRig(() => gatesRig({ own: 'ask' }), async (r) => {
    // an ordinary Ask card may appear for a shell command; what must NOT appear is the secret-read card
    for (const [tool, input] of [
      ['Bash', { command: `cat ${fwd}/projects.json` }],
      ['Bash', { command: `cat ${fwd}/workspaces/x/keys.json` }],
      ['Bash', { command: `ls ${fwd}/providers` }],
      ['Bash', { command: 'cat keys.json' }],
      ['PowerShell', { command: `Get-Content ${DATA}\\logs\\core.log` }],
    ] as Array<[string, Record<string, unknown>]>) {
      const o = await ask(r, tool, input);
      assert.doesNotMatch(o.summary, /may hold passwords or keys|key files are inside it/, `${tool} ${JSON.stringify(input)}`);
    }
  });
});

test('I1: the card says what is being read', async () => {
  await withRig(() => gatesRig({ own: 'ask' }), async (r) => {
    const o = await ask(r, 'Read', { file_path: `${fwd}/providers/keys.json` });
    assert.equal(o.summary, `Legion wants to read ${resolve(`${fwd}/providers/keys.json`)}. It may hold passwords or keys.`);
  });
});

test('I1: after a read of a key file (seen, whatever the answer), a call to an approved site asks and has no Always allow', async () => {
  for (const [mode, make] of RIGS) {
    await withRig(make, async (r) => {
      r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
      const before = await r.run('WebFetch', { url: 'https://trusted.example/a' });
      assert.equal(before.card, false, `${mode}: an approved site runs before any read`);
      r.noteUse('Read', { file_path: `${fwd}/providers/keys.json` });
      const p = r.call('WebFetch', { url: 'https://trusted.example/b' }); await r.tick();
      assert.equal(r.pending().length, 1, `${mode}: asks after the read`);
      assert.equal(r.pending()[0]!.site?.canAlways, false);
      r.answer(false); await p;
    });
  }
});

test('I1: a shell reader of a key file sets the same flag (noted when the call is seen)', async () => {
  await withRig(() => gatesRig({ preset: 'smart', follow: true }), async (r) => {
    r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
    r.noteUse('Bash', { command: `type ${DATA}\\connectors\\key.bin` });
    const p = r.call('WebFetch', { url: 'https://trusted.example/b' }); await r.tick();
    assert.equal(r.pending().length, 1); r.answer(false); await p;
  });
});

test('I1: with secret-file-reads off there is no read card, but web calls still ask', async () => {
  await withRig(() => gatesRig({ preset: 'smart', follow: true }), async (r) => {
    r.setGateOverride('secret-file-reads', false);
    r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
    r.noteUse('Read', { file_path: `${fwd}/providers/keys.json` });
    assert.equal((await ask(r, 'Read', { file_path: `${fwd}/providers/keys.json` })).card, false);
    const p = r.call('WebFetch', { url: 'https://trusted.example/b' }); await r.tick();
    assert.equal(r.pending().length, 1); r.answer(false); await p;
  });
});

test('the pure matcher: no data folder known means the same answers as before; the home spellings expand', () => {
  assert.equal(secretReadHit('Read', { file_path: `${fwd}/providers/keys.json` }), undefined);
  const where = { cwd: DATA, dataFolder: DATA, inside: (p: string) => p.endsWith('keys.json'), reaches: () => false, globReaches: () => false };
  assert.equal(secretReadHit('Read', { file_path: `${fwd}/providers/keys.json` }, where), `${fwd}/providers/keys.json`);
  const h = homedir();
  for (const w of ['~/x', '$HOME/x', '${HOME}/x', '%USERPROFILE%/x', '%HOME%\\x', '$env:USERPROFILE/x', '$env:HOME\\x']) assert.equal(expandHomeWord(w).startsWith(h), true, w);
  assert.equal(expandHomeWord('a/b'), 'a/b');
  assert.equal(expandHomeWord('~other/x'), '~other/x');
  assert.equal(dirname(expandHomeWord('~/x')), h);
});

// ---- fix round 2: a search over the folder that holds the keys, and a shell that moves into it first ----
const HOME_SPELLING = '~/.legion-secrettest';
const SEARCHES: Array<[string, Record<string, unknown>]> = [
  ['Grep', { pattern: 'sk-', path: DATA }],
  ['Grep', { pattern: 'sk-', path: fwd }],
  ['Grep', { pattern: 'sk-', path: DATA, glob: 'keys.json' }],
  ['Grep', { pattern: 'sk-', path: fwd, glob: '*.json' }],
  ['Grep', { pattern: 'sk-', path: fwd, glob: '**/*.enc' }],
  ['Grep', { pattern: 'sk-', path: fwd, glob: 'providers/**' }],
  ['Grep', { pattern: 'sk-', path: fwd, glob: '{keys,key}.*', output_mode: 'content' }],
  ['Grep', { pattern: 'sk-', path: homedir() }],
  ['Grep', { pattern: 'sk-', path: DATA, glob: '!*.log', output_mode: 'content' }],
  ['Grep', { pattern: 'sk-', path: DATA, glob: '*.log keys.json' }],
  ['Grep', { pattern: 'sk-', path: DATA, glob: '*.log,keys.json' }],
  ['Glob', { path: DATA, pattern: '**/keys.json' }],
  ['Glob', { pattern: `${fwd}/**/*.enc` }],
  ['Glob', { pattern: `${fwd}/*/keys.json` }],
  ['Glob', { path: fwd, pattern: '*/*.json' }],
  ['Bash', { command: `grep -r sk- ${fwd}` }],
  ['Bash', { command: `grep -rn sk- ${fwd}/` }],
  ['Bash', { command: `grep -R --include=keys.json sk- ${HOME_SPELLING}` }],
  ['Bash', { command: `grep --recursive sk- ${HOME_SPELLING}` }],
  ['Bash', { command: `rg sk- ${fwd}` }],
  ['Bash', { command: `rg -n sk- ${HOME_SPELLING}` }],
  ['Bash', { command: 'grep -r sk- ~' }],
  ['Bash', { command: `cd ${fwd}/providers && cat keys.json` }],
  ['Bash', { command: `cd ${HOME_SPELLING}/providers; head -c 50 keys.enc` }],
  ['Bash', { command: `cd ${fwd} && cat providers/keys.json` }],
  ['Bash', { command: `cd ${fwd} && cat ./gates/app.json` }],
  ['Bash', { command: `cat ${fwd}/*/keys.json` }],
  ['Bash', { command: `ls ${fwd}/providers/* | xargs cat` }],
  ['Bash', { command: 'cd && cat .legion-secrettest/providers/keys.json' }],
  ['PowerShell', { command: `Get-ChildItem ${DATA}\\providers | Get-Content` }],
  ['PowerShell', { command: `findstr /s /i sk- ${DATA}\\*` }],
  ['PowerShell', { command: `Get-ChildItem -Recurse ${DATA} | Select-String sk-` }],
  ['PowerShell', { command: `gci -Recurse -Path ${DATA} -Filter *.json | Get-Content` }],
  ['PowerShell', { command: `cd ${DATA}\\providers; Get-Content keys.json` }],
  ['PowerShell', { command: `Set-Location ${DATA}\\connectors; type key.bin` }],
  ['mcp__host__shell', { command: `grep -r sk- ${fwd}` }],
];
const SEARCHES_FREE: Array<[string, Record<string, unknown>]> = [
  ['Grep', { pattern: 'sk-', path: DATA, glob: '*.log' }],
  ['Grep', { pattern: 'sk-', path: DATA, glob: '*.{log,md}' }],
  ['Bash', { command: `ls ${fwd}/logs | xargs cat` }],
  ['Bash', { command: `ls ${fwd}/workspaces | wc -l` }],
  ['Bash', { command: 'cd && cat notes.txt' }],
  ['PowerShell', { command: `Get-ChildItem ${DATA}\\providers` }],
  ['Grep', { pattern: 'sk-', path: fwd, glob: '*.md' }],
  ['Grep', { pattern: 'sk-', path: `${fwd}/workspaces` }],
  ['Grep', { pattern: 'sk-', path: `${fwd}/logs` }],
  ['Grep', { pattern: 'sk-', path: `${fwd}/config.json` }],
  ['Glob', { path: DATA, pattern: '*.md' }],
  ['Glob', { pattern: `${fwd}/workspaces/**/*.ts` }],
  ['LS', { path: DATA }],
  ['Bash', { command: `grep -r sk- ${fwd}/workspaces` }],
  ['Bash', { command: `rg sk- ${fwd}/logs` }],
  ['Bash', { command: `grep sk- ${fwd}/config.json` }],
  ['Bash', { command: 'grep -r sk- src' }],
  ['Bash', { command: 'rg TODO' }],
  ['Bash', { command: `cd ${fwd}/workspaces && cat keys.json` }],
  ['Bash', { command: `cd ${fwd}/logs; grep -r x .` }],
  ['Bash', { command: `grep sk- ${fwd}/state.json` }],
  ['PowerShell', { command: `Get-ChildItem -Recurse ${DATA}` }],
  ['PowerShell', { command: `findstr /s sk- ${DATA}\\workspaces\\*` }],
];

test('fix round 2: a search over the data folder, or a shell that moves into a key folder first, cards in Ask, Accept edits and Smart with no Remember', async () => {
  for (const [mode, make] of RIGS) {
    await withRig(make, async (r) => {
      for (const [tool, input] of SEARCHES) {
        const o = await ask(r, tool, input);
        assert.equal(o.card, true, `${mode}: ${tool} ${JSON.stringify(input)}`);
        assert.equal(o.noRemember, true, `${mode}: no Remember: ${tool} ${JSON.stringify(input)}`);
        assert.match(o.summary, /^(Legion wants to read .+\. It may hold passwords or keys\.|An agent wants to search .+\. Legion's key files are inside it \(.+\), so the search can read your passwords and keys\.)$/, `${mode}: the secret-read card: ${tool} ${JSON.stringify(input)}`);
      }
    });
  }
});

test('fix round 2: searches that cannot reach a key file stay free (no secret-read card)', async () => {
  for (const [mode, make] of RIGS) {
    await withRig(make, async (r) => {
      for (const [tool, input] of SEARCHES_FREE) {
        const o = await ask(r, tool, input);
        assert.doesNotMatch(o.summary, /may hold passwords or keys|key files are inside it/, `${mode}: ${tool} ${JSON.stringify(input)}`);
      }
    });
  }
});

test('fix round 2: Bypass does not card those searches', async () => {
  await withRig(() => gatesRig({ own: 'full' }), async (r) => {
    for (const [tool, input] of SEARCHES) assert.equal((await ask(r, tool, input)).card, false, `${tool} ${JSON.stringify(input)}`);
  });
});

test('fix round 2: a search over the data folder sets the same flag: a later call to an approved site asks', async () => {
  for (const probe of [['Grep', { pattern: 'sk-', path: DATA }], ['Grep', { pattern: 'sk-', path: DATA, glob: 'keys.json' }], ['Bash', { command: `grep -r sk- ${fwd}` }], ['Bash', { command: `cd ${fwd}/providers && cat keys.json` }], ['Bash', { command: `find ${fwd} -name keys.json -exec cat {} +` }], ['Grep', { pattern: 'sk-', path: DATA, glob: '!*.log', output_mode: 'content' }], ['Bash', { command: `ls ${fwd}/providers/* | xargs cat` }], ['PowerShell', { command: `Get-ChildItem ${DATA}\\providers | Get-Content` }], ['Bash', { command: 'cd && cat .legion-secrettest/providers/keys.json' }]] as Array<[string, Record<string, unknown>]>) {
    await withRig(() => gatesRig({ preset: 'smart', follow: true }), async (r) => {
      r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
      assert.equal((await r.run('WebFetch', { url: 'https://trusted.example/a' })).card, false);
      r.noteUse(probe[0], probe[1]);
      const p = r.call('WebFetch', { url: 'https://trusted.example/b' }); await r.tick();
      assert.equal(r.pending().length, 1, `${probe[0]} ${JSON.stringify(probe[1])}`); r.answer(false); await p;
    });
  }
});

test('fix round 3: a search folder that only contains the key folders is worded as a search; a key file keeps the read wording; always full paths', async () => {
  await withRig(() => gatesRig({ own: 'ask' }), async (r) => {
    const search = (folder: string) => `An agent wants to search ${resolve(folder)}. Legion's key files are inside it (${DATA}), so the search can read your passwords and keys.`;
    assert.equal((await ask(r, 'Grep', { pattern: 'sk-', path: DATA })).summary, search(DATA));
    assert.equal((await ask(r, 'Grep', { pattern: 'sk-', path: homedir() })).summary, search(homedir()));
    assert.equal((await ask(r, 'Glob', { path: DATA, pattern: '**/keys.json' })).summary, search(DATA));
    assert.equal((await ask(r, 'Bash', { command: 'grep -r sk- ~' })).summary, search(homedir()));
    assert.equal((await ask(r, 'Bash', { command: `rg sk- ${fwd}/` })).summary, search(DATA));
    const read = (file: string) => `Legion wants to read ${resolve(file)}. It may hold passwords or keys.`;
    assert.equal((await ask(r, 'Read', { file_path: `${fwd}/gates-key.bin` })).summary, read(`${fwd}/gates-key.bin`));
    assert.equal((await ask(r, 'Read', { file_path: `${r.projectDir()}/.env` })).summary, read(`${r.projectDir()}/.env`));
    assert.equal((await ask(r, 'Bash', { command: `cd ${fwd}/providers && cat keys.json` })).summary, read(`${fwd}/providers/keys.json`), 'the command'+"'"+'s own cd decides the path shown');
    assert.equal((await ask(r, 'Bash', { command: 'cd && cat .legion-secrettest/providers/keys.json' })).summary, read(`${fwd}/providers/keys.json`));
    for (const [tool, input] of SEARCHES) {
      const o = await ask(r, tool, input);
      assert.doesNotMatch(o.summary, /read \.+\.|read [A-Za-z]+\. It/, `${tool} ${JSON.stringify(input)}: ${o.summary}`);
    }
  });
});
