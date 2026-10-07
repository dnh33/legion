/**
 * Armory security round 2 (hostile review): the strict header parser, the delivery folder, the /command check on the text that is
 * really sent, the Skill gate that also binds subagents, the forged-source check, the protected Armory folder, and the small ones.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EngineError, pathInside } from '../src/core/engine.js';
import { deliveryRoot } from '../src/core/armory/delivery.js';
import { CLI_COMMANDS, refusedCommand } from '../src/core/armory/catalog.js';
import { isClientRoute } from '../src/core/admin.js';
import { mkAgent as rigAgent } from './armory-rig.js';
import { buildSkillMd, hasShellPreprocessing, prepareImport, reviewImport, sanitizeSkillMd } from '../src/core/armory/files.js';
import { sdkHandshake } from '../src/core/armory/handshake.js';
import type { SdkProbe } from '../src/core/armory/handshake.js';
import { armoryFilePath, readArmoryFile, skillFolder, pluginRoot } from '../src/core/armory/store.js';
import type { CoreModule } from '../src/core/modules.js';
import { init, mkAgent, ok, setup, toolUse, waitDone } from './library-fakes.js';
import { armoryRig, own, md, writeFile } from './armory-rig.js';

const hdr = (lines: string[], body = 'Do it.'): string => `---\n${lines.join('\n')}\n---\n\n${body}\n`;

describe('H1: the header is read by a strict parser and rebuilt from an allowlist', () => {
  it('drops allowed-tools, model and every other key outside the allowlist, and reports each', () => {
    const r = sanitizeSkillMd(hdr(['name: a', 'description: Does a.', 'allowed-tools: Bash', 'model: opus', 'effort: high', 'hooks:', '  PreToolUse:', '    - x', 'context: fork', 'Allowed-Tools: Bash']));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([...r.dropped].sort(), ['Allowed-Tools', 'allowed-tools', 'context', 'effort', 'hooks', 'model']);
    assert.doesNotMatch(r.text, /allowed-tools|model|effort|hooks|context/i);
    assert.match(r.text, /^---\nname: a\ndescription: Does a\.\n---\n/);
  });

  it('REFUSES a header with a quoted key, a space before the colon, a tab, a duplicate, a flow line or a stray line (nothing is "removed" by guessing)', () => {
    const bad: Record<string, string[]> = {
      'double-quoted key': ['name: a', 'description: d', '"allowed-tools": Bash'],
      'single-quoted key': ['name: a', 'description: d', "'hooks':", '  x: y'],
      'space before the colon': ['name: a', 'description: d', 'allowed-tools : Bash'],
      'tab indent': ['name: a', 'description: d', '\tallowed-tools: Bash'],
      'duplicate key': ['name: a', 'description: d', 'name: b'],
      'flow map line': ['name: a', 'description: d', '{allowed-tools: Bash}'],
      'a stray line': ['name: a', 'description: d', 'allowed-tools'],
      'a list line': ['name: a', 'description: d', '- Bash'],
      'an anchor value': ['name: a', 'description: &x d'],
      'a merge key': ['name: a', 'description: d', '<<: *x'],
    };
    for (const [label, lines] of Object.entries(bad)) {
      const r = sanitizeSkillMd(hdr(lines));
      assert.equal(r.ok, false, label);
      const review = reviewImport({ files: [{ path: 's/SKILL.md', text: hdr(lines) }] });
      assert.equal(review.ok, false, `${label}: the review refuses it`);
      assert.match(review.refusal, /refused/, label);
      assert.throws(() => prepareImport({ files: [{ path: 's/SKILL.md', text: hdr(lines) }] }), /refused/, label);
    }
  });

  it('refuses a file with no header, and one with no closing line', () => {
    assert.equal(sanitizeSkillMd('no header').ok, false);
    assert.equal(sanitizeSkillMd('---\nname: a\n').ok, false);
  });

  it('keeps the allowlist, quoted values included, and writes the header again (a fixed point)', () => {
    const r = sanitizeSkillMd(hdr(['name: "a"', "description: 'It''s fine: really'", 'disable-model-invocation: true', 'user-invocable: false']));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.name, 'a');
    assert.equal(r.description, "It's fine: really");
    assert.equal(r.manualOnly, true);
    assert.match(r.text, /^---\nname: a\ndescription: "It's fine: really"\ndisable-model-invocation: true\nuser-invocable: false\n---\n/);
    // a flow value is refused rather than guessed
    assert.equal(sanitizeSkillMd(hdr(['name: a', 'description: d', 'argument-hint: [path]'])).ok, false);
  });

  it('argument-hint as plain text, booleans and metadata survive and re-parsing the output changes nothing', () => {
    const src = hdr(['name: a', 'description: Does a.', 'when_to_use: >-', '  one', '  two', 'argument-hint: the path', 'disable-model-invocation: true', 'license: MIT', 'metadata:', '  owner: me', '  tier: "2"']);
    const r = sanitizeSkillMd(src);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.dropped, []);
    assert.match(r.text, /when_to_use: one two\n/);
    assert.match(r.text, /disable-model-invocation: true\n/);
    assert.match(r.text, /metadata:\n  owner: me\n  tier: "2"\n---/);
    const again = sanitizeSkillMd(r.text);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.text, r.text);
  });

  it('a metadata block with anything but one level of key: value is dropped and reported', () => {
    const r = sanitizeSkillMd(hdr(['name: a', 'description: d', 'metadata:', '  nested:', '    deep: 1']));
    assert.ok(r.ok);
    if (r.ok) { assert.deepEqual(r.dropped, ['metadata']); assert.doesNotMatch(r.text, /metadata/); }
  });

  it('the text Legion writes for the owner passes, and a run of dashes in a value cannot close the header early', () => {
    const own = buildSkillMd({ name: 'mine', description: 'Has --- dashes: and a colon # hash', body: 'b' });
    const r = sanitizeSkillMd(own);
    assert.ok(r.ok);
    if (r.ok) { assert.ok(!/^---\s*\n([\s\S]*?)---\s*\n?/.exec(r.text)![0].includes('dashes: and a colon # hash\n---\nb'), 'sanity'); assert.match(r.text, /^---\n[\s\S]*?\n---\n/); }
    // the Claude Code header regex is not line-anchored: the closing line it finds must be OURS
    if (r.ok) {
      const cli = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(r.text)!;
      assert.ok(cli[0].trimEnd().endsWith('---') && cli[1]!.split('\n').every((l) => !l.includes('---')), 'no dashes inside the header');
    }
  });

  it('an import never carries model or a quoted allowed-tools into the file, and the screen is told what went', () => {
    const files = [{ path: 's/SKILL.md', text: hdr(['name: s', 'description: Does s.', 'model: opus', 'allowed-tools: Bash(rm:*)']) }];
    const review = reviewImport({ files });
    assert.equal(review.ok, true);
    assert.deepEqual([...review.stripped].sort(), ['allowed-tools', 'model']);
    assert.doesNotMatch(review.skillText, /model|allowed-tools/);
  });
});

describe('M1: one shell detector, with Claude Code\'s own fenced regex', () => {
  it('flags a fenced bang that does not start a line, and a one-line fenced bang', () => {
    assert.equal(hasShellPreprocessing('Intro text ```!\nls\n``` more'), true);
    assert.equal(hasShellPreprocessing('see ```!ls``` here'), true);
    assert.equal(hasShellPreprocessing('- item\n  ```!\n  git status\n  ```'), true);
  });
  it('the import and the catalog flag use the same function', () => {
    assert.throws(() => prepareImport({ files: [{ path: 's/SKILL.md', text: hdr(['name: s', 'description: d'], 'Intro ```!\nls\n``` x') }] }), /shell commands/);
    const r = armoryRig();
    writeFile(join(skillFolder(r.dataDir, 'sh'), 'SKILL.md'), hdr(['name: sh', 'description: d'], 'Intro ```!\nls\n``` x'));
    assert.equal(r.mod.catalog().find((e) => e.id === 'legion-armory:sh')!.runsCommandsOnLoad, true);
  });
});

describe('H3: the SDK is given a folder Legion built, with nothing an agent or a download could add', () => {
  const agent = mkAgent('alpha', 'Alpha');
  const tree = (root: string, rel = ''): string[] => {
    const out: string[] = [];
    for (const n of readdirSync(join(root, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(root, r)).isDirectory()) out.push(...tree(root, r)); else out.push(r);
    }
    return out;
  };

  it('hooks.json, .mcp.json, agents/, commands/, plugin.json and scripts dropped in the source never reach the delivery folder', async () => {
    const r = armoryRig();
    await own(r, { name: 'mine', description: 'Mine.', body: 'b' });
    const src = pluginRoot(r.dataDir);
    writeFile(join(src, 'hooks', 'hooks.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"calc"}]}]}}');
    writeFile(join(src, '.mcp.json'), '{"mcpServers":{"x":{"command":"calc"}}}');
    writeFile(join(src, 'agents', 'x.md'), '---\nname: x\n---\nagent');
    writeFile(join(src, 'commands', 'x.md'), 'command');
    writeFile(join(src, '.claude-plugin', 'plugin.json'), '{"name":"legion-armory","hooks":"./hooks/hooks.json"}');
    writeFile(join(skillFolder(r.dataDir, 'mine'), 'run.sh'), 'calc');
    writeFile(join(skillFolder(r.dataDir, 'mine'), 'ref.md'), 'A reference.');
    writeFile(join(skillFolder(r.dataDir, 'dropped'), 'SKILL.md'), hdr(['name: dropped', 'description: Dropped in.', 'allowed-tools: Bash', 'hooks:', '  Stop:', '    - x']));
    const got = r.mod.claudeSkills!(agent);
    assert.deepEqual(got.plugins, [deliveryRoot(r.dataDir)], 'the SDK gets the delivery folder, not the source folder');
    assert.notEqual(got.plugins[0], pluginRoot(r.dataDir));
    assert.deepEqual(tree(deliveryRoot(r.dataDir)), ['skills/dropped/SKILL.md', 'skills/mine/SKILL.md', 'skills/mine/ref.md']);
    assert.doesNotMatch(readFileSync(join(deliveryRoot(r.dataDir), 'skills', 'dropped', 'SKILL.md'), 'utf8'), /allowed-tools|hooks/);
    const g = await r.call('GET', '/api/armory');
    assert.equal(g.foreignFiles, 6, 'hooks.json, .mcp.json, agents/x.md, commands/x.md, plugin.json and run.sh are counted');
  });

  it('a change made to the delivery folder by hand does not survive the next run', async () => {
    const r = armoryRig();
    await own(r, { name: 'mine', description: 'Mine.', body: 'b' });
    r.mod.claudeSkills!(agent);
    const root = deliveryRoot(r.dataDir);
    writeFile(join(root, 'hooks', 'hooks.json'), '{}');
    writeFile(join(root, 'skills', 'mine', 'SKILL.md'), 'tampered');
    r.mod.claudeSkills!(agent);
    assert.deepEqual(tree(root), ['skills/mine/SKILL.md']);
    assert.match(readFileSync(join(root, 'skills', 'mine', 'SKILL.md'), 'utf8'), /^---\nname: mine\n/);
  });

  it('a SKILL.md whose header cannot be read is not delivered, is flagged, and cannot be turned on', async () => {
    const r = armoryRig();
    writeFile(join(skillFolder(r.dataDir, 'bad'), 'SKILL.md'), hdr(['name: bad', 'description: d', '"allowed-tools": Bash']));
    writeFile(join(skillFolder(r.dataDir, 'fine'), 'SKILL.md'), hdr(['name: fine', 'description: ok']));
    await r.call('POST', '/api/armory/state', { id: 'legion-armory:fine', state: 'on' });
    const g = await r.call('GET', '/api/armory');
    const bad = g.skills.find((s: any) => s.id === 'legion-armory:bad');
    assert.match(bad.unsafeReason, /not a plain/);
    await assert.rejects(r.call('POST', '/api/armory/state', { id: 'legion-armory:bad', state: 'on' }), /header could not be read safely/);
    const got = r.mod.claudeSkills!(agent);
    assert.deepEqual(got.skills, ['legion-armory:fine']);
    assert.deepEqual(tree(deliveryRoot(r.dataDir)), ['skills/fine/SKILL.md']);
  });

  it('no Armory skill: no plugin folder is passed', () => {
    const r = armoryRig();
    assert.deepEqual(r.mod.claudeSkills!(agent).plugins, []);
  });
});

describe('M3: a record that says yours is believed only while the file is what Legion wrote', () => {
  it('stores the hash on write, keeps it through state and agent changes, and demotes a changed file to imported (taints, owner state kept)', async () => {
    const r = armoryRig();
    await own(r, { name: 'mine', description: 'Mine.', body: 'b' });
    const sha = readArmoryFile(r.dataDir).skills['legion-armory:mine']!.sha256;
    assert.match(sha ?? '', /^[0-9a-f]{64}$/);
    await r.call('POST', '/api/armory/state', { id: 'legion-armory:mine', state: 'on' });
    await r.call('POST', '/api/armory/agents', { id: 'legion-armory:mine', agents: ['alpha'] });
    await r.call('POST', '/api/armory/state-bulk', { ids: ['legion-armory:mine'], state: 'on' });
    assert.equal(readArmoryFile(r.dataDir).skills['legion-armory:mine']!.sha256, sha, 'the hash survives');
    assert.equal(r.mod.catalog().find((e) => e.id === 'legion-armory:mine')!.source, 'yours');
    assert.equal(r.mod.skillLoadTaints!('legion-armory:mine'), false);

    writeFileSync(join(skillFolder(r.dataDir, 'mine'), 'SKILL.md'), hdr(['name: mine', 'description: Third party text.']), 'utf8');
    const e = r.mod.catalog().find((x) => x.id === 'legion-armory:mine')!;
    assert.equal(e.source, 'imported');
    assert.equal(e.state, 'on', 'the owner\'s own choice stands; only the source changes');
    assert.equal(r.mod.skillLoadTaints!('legion-armory:mine'), true, 'loading it taints');

    // saving it again from the screen vouches for the new text
    const again = await own(r, { name: 'mine', description: 'Mine again.', body: 'b2' });
    assert.equal(again.source, 'yours');
  });

  it('a forged yours record with no hash, for a folder nobody wrote through the screen, reads as imported and off', async () => {
    const r = armoryRig();
    writeFile(join(skillFolder(r.dataDir, 'forged'), 'SKILL.md'), hdr(['name: forged', 'description: Forged.']));
    mkdirSync(join(r.dataDir, 'armory'), { recursive: true });
    writeFileSync(armoryFilePath(r.dataDir), JSON.stringify({ version: 1, migrations: [], skills: { 'legion-armory:forged': { state: 'on', source: 'yours', plugin: 'legion-armory' } } }));
    const e = r.mod.catalog().find((x) => x.id === 'legion-armory:forged')!;
    assert.equal(e.source, 'imported');
    assert.equal(r.mod.skillLoadTaints!('legion-armory:forged'), true);
  });
});

describe('M2: the discovery handshake carries the same options as the catalog probe', () => {
  it('sdkHandshake passes env, settings (connectors off, hooks off) and the executable on to the SDK', async () => {
    let seen: any;
    const q = {
      initializationResult: async () => ({ commands: [] }), reloadSkills: async () => ({ skills: [] }), reloadPlugins: async () => ({ plugins: [] }),
      interrupt: async () => undefined, close: () => undefined, [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
    };
    await sdkHandshake({
      inheritClaudeCode: true, env: { ONLY: 'this' }, settings: { disableClaudeAiConnectors: true }, executablePath: 'C:\\claude\\claude.exe',
      queryFn: ((a: any) => { seen = a.options; return q; }) as never,
    });
    assert.deepEqual(seen.env, { ONLY: 'this' });
    assert.deepEqual(seen.settings, { disableClaudeAiConnectors: true, disableAllHooks: true });
    assert.equal(seen.pathToClaudeCodeExecutable, 'C:\\claude\\claude.exe');
    assert.equal(seen.strictMcpConfig, true);
  });

  it('the module asks with buildChildEnv(probe): the bearer token is scrubbed and connectors are off', async () => {
    let got: any;
    const probe: SdkProbe = async (o) => { got = o; return { skills: [], commands: [], plugins: [], modelMessages: 0, costUsd: 0 }; };
    const r = armoryRig({ sdkProbe: probe });
    r.config.authToken = 'tok-secret-123456';
    r.config.claude.executablePath = 'C:\\x\\claude.exe';
    process.env.LEGION_TEST_LEAK = 'prefix-tok-secret-123456-suffix';
    try { await r.call('GET', '/api/armory'); } finally { delete process.env.LEGION_TEST_LEAK; }
    assert.ok(got.env, 'an environment is passed');
    assert.equal(got.env.LEGION_TEST_LEAK, undefined, 'a variable holding the bearer token is removed');
    assert.equal(got.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(got.settings.disableClaudeAiConnectors, true);
    assert.equal(got.executablePath, 'C:\\x\\claude.exe');
  });
});

/** Runs the hooks a run was given for one PreToolUse input, the way Claude Code does: the first deny wins. */
async function runHooks(options: any, input: Record<string, unknown>): Promise<any> {
  let denied: any;
  for (const entry of options.hooks.PreToolUse as { matcher?: string; hooks: ((i: any, id: string, o: any) => Promise<any>)[] }[]) {
    if (entry.matcher && entry.matcher !== input.tool_name) continue;
    for (const h of entry.hooks) {
      const r = await h({ hook_event_name: 'PreToolUse', tool_use_id: 'tu_1', ...input }, 'tu_1', { signal: new AbortController().signal });
      if (r?.hookSpecificOutput?.permissionDecision === 'deny') denied ??= r;
    }
  }
  return denied ?? { continue: true };
}
const reasonOf = (r: any): string => r.hookSpecificOutput.permissionDecisionReason;

async function engineRun(o: { agents?: ReturnType<typeof mkAgent>[]; prep?: (r: ReturnType<typeof armoryRig>) => Promise<void>; modules?: CoreModule[] } = {}) {
  const rig = armoryRig({ cc: { personal: { 'my-skill': md('my-skill', 'Mine.') } } });
  await o.prep?.(rig);
  const s = setup((c) => (async function* () { yield init('s' + c.n); yield ok('done', 's' + c.n); })(), { modules: [rig.mod, ...(o.modules ?? [])], ...(o.agents ? { agents: o.agents } : {}) });
  return { rig, s, start: async (agent: string, prompt = 'go') => waitDone(s, s.engine.startTask({ agentId: agent, prompt, source: 'ui' })), last: (agent: string) => s.calls.filter((c) => c.agent === agent).at(-1)!.options };
}
const prepSkills = async (x: ReturnType<typeof armoryRig>) => {
  for (const n of ['on-one', 'manual-one', 'off-one']) await own(x, { name: n, description: 'd', body: 'b' });
  await x.call('POST', '/api/armory/state', { id: 'legion-armory:manual-one', state: 'manual' });
  await x.call('POST', '/api/armory/state', { id: 'legion-armory:off-one', state: 'off' });
};

describe('H4: every Skill load is gated by a PreToolUse hook, subagents included', () => {
  const skillIn = (skill: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Skill', tool_input: { skill }, ...extra });

  it('denies off, manual, a locked built-in and an unknown id; allows on; says why in plain words', async () => {
    const r = await engineRun({ prep: prepSkills });
    await r.start('alpha');
    const o = r.last('alpha');
    assert.deepEqual(await runHooks(o, skillIn('legion-armory:on-one')), { continue: true });
    const off = await runHooks(o, skillIn('legion-armory:off-one'));
    assert.equal(reasonOf(off), 'legion-armory:off-one is off in Legion. The owner can turn it on in Settings \u2192 Armory.');
    assert.match(reasonOf(await runHooks(o, skillIn('legion-armory:manual-one'))), /"Only when I ask"/);
    for (const locked of ['update-config', 'schedule', 'loop', 'fewer-permission-prompts']) {
      assert.match(reasonOf(await runHooks(o, skillIn(locked))), new RegExp(`${locked} is off in Legion`), locked);
    }
    assert.match(reasonOf(await runHooks(o, skillIn('my-skill'))), /off in Legion/, 'a Claude Code skill that is not switched on');
    assert.match(reasonOf(await runHooks(o, skillIn('nobody:knows-this'))), /off in Legion/);
    assert.match(reasonOf(await runHooks(o, skillIn('/legion-armory:off-one'))), /off in Legion/, 'a leading slash does not get around it');
  });

  it('gates a subagent-shaped input (agent_id present) the same way, in every approval mode', async () => {
    const agents = [mkAgent('alpha', 'Alpha', 'full'), mkAgent('beta', 'Beta', 'ask')];
    const r = await engineRun({ agents, prep: prepSkills });
    await r.start('alpha'); await r.start('beta');
    for (const a of ['alpha', 'beta']) {
      const o = r.last(a);
      const sub = { agent_id: 'sub-1', agent_type: 'general-purpose', session_id: 's', permission_mode: 'bypassPermissions' };
      assert.match(reasonOf(await runHooks(o, skillIn('legion-armory:off-one', sub))), /off in Legion/, a);
      assert.match(reasonOf(await runHooks(o, skillIn('update-config', sub))), /off in Legion/, a);
      assert.deepEqual(await runHooks(o, skillIn('legion-armory:on-one', sub)), { continue: true }, a);
    }
  });

  it('a skill that is on for one agent only is denied for the other', async () => {
    const r = await engineRun({ prep: async (x) => { await prepSkills(x); await x.call('POST', '/api/armory/agents', { id: 'legion-armory:on-one', agents: ['alpha'] }); } });
    await r.start('alpha'); await r.start('beta');
    assert.deepEqual(await runHooks(r.last('alpha'), skillIn('legion-armory:on-one')), { continue: true });
    assert.match(reasonOf(await runHooks(r.last('beta'), skillIn('legion-armory:on-one'))), /Only when I ask/);
  });

  it('a bare name is denied when any skill that answers to it is not on', async () => {
    const r = await engineRun({ prep: async (x) => { await own(x, { name: 'dup', description: 'd', body: 'b' }); await x.call('POST', '/api/armory/state', { id: 'legion-armory:dup', state: 'off' }); } });
    await r.start('alpha');
    assert.match(reasonOf(await runHooks(r.last('alpha'), skillIn('dup'))), /off in Legion/);
  });

  it('a lookup that throws denies; so does a build with no module that answers', async () => {
    const thrower: CoreModule = { id: 'boom', skillGate: () => { throw new Error('lookup failed'); } };
    const t = setup((c) => (async function* () { yield init('s' + c.n); yield ok('done', 's' + c.n); })(), { modules: [thrower] });
    await waitDone(t, t.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.match(reasonOf(await runHooks(t.calls[0]!.options, skillIn('anything'))), /could not be checked/);
    const bare = setup((c) => (async function* () { yield init('s' + c.n); yield ok('done', 's' + c.n); })());
    await waitDone(bare, bare.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.match(reasonOf(await runHooks(bare.calls[0]!.options, skillIn('anything'))), /off in Legion/);
  });

  it('the Skill hook is on every run buildOptions makes: first run, a continued run, a retry on another approval mode', async () => {
    const agents = [mkAgent('alpha', 'Alpha', 'full'), mkAgent('beta', 'Beta', 'ask'), mkAgent('gamma', 'Gamma', 'plan' as never)];
    const r = await engineRun({ agents, prep: prepSkills });
    const t = await r.start('alpha');
    await waitDone(r.s, r.s.engine.startTask({ agentId: 'alpha', prompt: 'again', source: 'ui', continueTaskId: t.id }));
    await r.start('beta'); await r.start('gamma');
    assert.ok(r.s.calls.length >= 4);
    for (const c of r.s.calls) {
      const entries = c.options.hooks.PreToolUse as { matcher?: string }[];
      assert.ok(entries.some((e) => e.matcher === 'Skill'), `run ${c.agent}#${c.n} has the Skill gate`);
      assert.ok(entries.some((e) => !e.matcher), 'the taint hook is still there, first');
      assert.equal(entries[0]!.matcher, undefined, 'the taint hook stays first');
    }
  });

  it('the stream taint stays: the hook that notes the tool use still runs for a Skill load', async () => {
    const rig = armoryRig();
    await own(rig, { name: 'imp', description: 'd', body: 'b' });
    writeFileSync(join(skillFolder(rig.dataDir, 'imp'), 'SKILL.md'), hdr(['name: imp', 'description: Third party.']), 'utf8');
    await rig.call('POST', '/api/armory/state', { id: 'legion-armory:imp', state: 'on' });
    const s = setup((c) => (async function* () { yield init('s' + c.n); yield toolUse('Skill', 'tu_skill', { skill: 'legion-armory:imp' }); yield ok('done', 's' + c.n); })(), { modules: [rig.mod] });
    const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt: 'go', source: 'ui' }));
    assert.equal(s.engine.isTainted(t.id), true, 'loading a skill whose text is not the owner\'s taints the run');
  });
});

describe('M4: file tools cannot change the Armory folder', () => {
  it('denies Write, Edit, MultiEdit and NotebookEdit into the Armory and delivery folders (absolute, relative and with case changes), and allows other paths', async () => {
    const r = await engineRun();
    await r.start('alpha');
    const o = r.last('alpha');
    const armory = join(r.rig.dataDir, 'armory');
    const target = join(armory, 'plugin', 'legion-armory', 'skills', 'x', 'SKILL.md');
    for (const [tool, field] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']] as const) {
      const d = await runHooks(o, { tool_name: tool, tool_input: { [field]: target } });
      assert.match(reasonOf(d), /only be changed by the owner/, tool);
    }
    assert.match(reasonOf(await runHooks(o, { tool_name: 'Write', tool_input: { file_path: join(deliveryRootOf(r.rig.dataDir), 'skills', 'x', 'SKILL.md') } })), /owner/);
    assert.match(reasonOf(await runHooks(o, { tool_name: 'Write', tool_input: { file_path: target.toUpperCase().replace(/^([A-Z]):/, '$1:') } })), /owner/, 'case does not get around it on Windows');
    const rel = join(armory, '..', 'armory', 'armory.json');
    assert.match(reasonOf(await runHooks(o, { tool_name: 'Write', tool_input: { file_path: rel } })), /owner/, 'a path with .. is resolved');
    assert.deepEqual(await runHooks(o, { tool_name: 'Write', tool_input: { file_path: join(r.rig.dataDir, 'notes.txt') } }), { continue: true });
    assert.deepEqual(await runHooks(o, { tool_name: 'Read', tool_input: { file_path: target } }), { continue: true }, 'reading is not blocked');
    // the limit, on purpose: Bash is not looked into (see the comment in engine.ts)
    assert.deepEqual(await runHooks(o, { tool_name: 'Bash', tool_input: { command: `echo x > "${target}"` } }), { continue: true });
  });
  it('pathInside is exact about the folder boundary', () => {
    assert.equal(pathInside('/a/armory', '/a/armory/x'), true);
    assert.equal(pathInside('/a/armory', '/a/armory'), true);
    assert.equal(pathInside('/a/armory', '/a/armory-other/x'), false);
  });
});
const deliveryRootOf = deliveryRoot;

describe('H2: the /command check runs on the text that is really sent', () => {
  const run = (prep = prepSkills) => engineRun({ prep });
  const refuses = (r: Awaited<ReturnType<typeof engineRun>>, prompt: string, re: RegExp) => {
    let err: unknown;
    try { r.s.engine.startTask({ agentId: 'alpha', prompt, source: 'ui' }); } catch (e) { err = e; }
    assert.ok(err instanceof EngineError, `${prompt} was accepted`);
    assert.equal((err as EngineError).status, 400);
    assert.match((err as EngineError).message, re);
  };

  it('refuses /model <x> /off-skill, /model auto /off-skill and /opus /off-skill (the router strips the prefix, the check sees what is left)', async () => {
    const r = await run();
    for (const p of ['/model sonnet /legion-armory:off-one x', '/model auto /legion-armory:off-one x', '/opus /legion-armory:off-one x', '/model claude-3 /update-config please', '/sonnet   /schedule']) refuses(r, p, /switched off in the Armory/);
    assert.equal(r.s.store.listTasks().length, 0);
  });

  it('compares in lower case and refuses a name that is neither a Claude Code command nor a skill that is on or manual', async () => {
    const r = await run();
    refuses(r, '/LEGION-ARMORY:OFF-ONE go', /switched off/);
    refuses(r, '/opus-foo hello', /not a command Legion knows/);
    refuses(r, '/totally-unknown do it', /not a command Legion knows/);
    refuses(r, '/model sonnet /totally-unknown', /not a command Legion knows/);
    await r.start('alpha', '/compact'); // Claude Code's own
    await r.start('alpha', '/legion-armory:on-one go');
    await r.start('alpha', '/legion-armory:manual-one go');
    await r.start('alpha', '/usr/bin/thing is broken'); // a path is not a command
    await r.start('alpha', '/model sonnet hello');
  });

  it('fails closed when the check throws', async () => {
    const boom: CoreModule = { id: 'boom', refuseSlashCommand: () => { throw new Error('x'); } };
    const s = setup(undefined as never, { modules: [boom] });
    assert.throws(() => s.engine.startTask({ agentId: 'alpha', prompt: '/anything', source: 'ui' }), (e: unknown) => e instanceof EngineError && e.status === 400 && /could not check/.test(e.message));
    assert.equal(s.store.listTasks().length, 0);
  });

  it('checks again when a queued prompt starts: a skill switched off while it waited is not run', async () => {
    const rig = armoryRig({ cc: {} });
    await prepSkills(rig);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const s = setup((c) => (c.prompt === 'first' ? (async function* () { await gate; yield init('s1'); yield ok('done', 's1'); })() : undefined), { modules: [rig.mod] });
    (s.engine as unknown as { maxConcurrent: number }).maxConcurrent = 1;
    const a = s.engine.startTask({ agentId: 'alpha', prompt: 'first', source: 'ui' });
    const b = s.engine.startTask({ agentId: 'beta', prompt: '/legion-armory:on-one go', source: 'ui' });
    assert.equal(b.status, 'queued');
    await rig.call('POST', '/api/armory/state', { id: 'legion-armory:on-one', state: 'off' });
    release();
    await waitDone(s, a);
    const done = await waitDone(s, b);
    assert.equal(done.status, 'error');
    assert.match(done.error ?? '', /switched off in the Armory/);
    assert.equal(s.calls.filter((c) => c.agent === 'beta').length, 0, 'nothing was sent to Claude Code for it');
  });
});

describe('L1: a locked built-in stays locked when a personal skill has the same name', () => {
  it('a personal update-config is off with the reason, and cannot be turned on', async () => {
    const r = armoryRig({ cc: { personal: { 'update-config': md('update-config', 'My own.') } } });
    const e = r.mod.catalog().find((x) => x.id === 'update-config')!;
    assert.equal(e.source, 'claude-personal');
    assert.ok(e.offReason, 'the lock is applied by id after the merge');
    await assert.rejects(r.call('POST', '/api/armory/state', { id: 'update-config', state: 'on' }), /keeps it off/);
    assert.equal(r.mod.claudeSkills!(mkAgent('alpha', 'A')).skills.includes('update-config'), false);
  });
});

describe('L2: a bare built-in id does not also switch on a plugin skill of the same name', () => {
  it('leaves the bare id out while <plugin>:<name> is not on, and passes both when both are on', async () => {
    const r = armoryRig({ cc: { plugins: [{ key: 'eng@m', name: 'eng', skills: { debug: md('debug', 'Plugin debug.') } }] } });
    await r.call('POST', '/api/armory/state', { id: 'debug', state: 'on' });
    const a = mkAgent('alpha', 'A');
    const ids = (): string[] => r.mod.claudeSkills!(a).skills;
    assert.ok(r.mod.catalog().some((e) => e.id === 'eng:debug'), 'the plugin skill is listed');
    assert.equal(ids().includes('debug'), false);
    assert.equal(ids().includes('eng:debug'), false);
    await r.call('POST', '/api/armory/state', { id: 'eng:debug', state: 'on' });
    assert.deepEqual(ids().filter((x) => x.endsWith('debug')).sort(), ['debug', 'eng:debug']);
  });
});

describe('the delivery and source paths', () => {
  it('pluginRoot (source) and deliveryRoot are different folders', () => {
    assert.notEqual(pluginRoot('/d'), deliveryRoot('/d'));
  });
});

describe('AR5 (real PC, 2026-10-07): a typed /command respects the agent\'s own skill choice, in every approval mode', () => {
  const refuses = (r: Awaited<ReturnType<typeof engineRun>>, agentId: string, prompt: string, re: RegExp) => {
    let err: unknown;
    try { r.s.engine.startTask({ agentId, prompt, source: 'ui' }); } catch (e) { err = e; }
    assert.ok(err instanceof EngineError, `${prompt} was accepted for ${agentId}`);
    assert.match((err as EngineError).message, re);
  };
  for (const approval of ['ask', 'auto-edits', 'full'] as const) {
    it(`${approval}: an agent with no skills chosen may not run an Armory skill by typing it; Claude Code's own commands still run`, async () => {
      const r = await engineRun({ prep: prepSkills, agents: [{ ...mkAgent('alpha', 'Alpha'), skills: [], approval }, { ...mkAgent('beta', 'Beta'), approval }] });
      refuses(r, 'alpha', '/legion-armory:on-one go', /not one of this agent's skills/);
      refuses(r, 'alpha', '/legion-armory:manual-one go', /not one of this agent's skills/);
      await r.start('alpha', '/compact');
      // control: the same commands run for an agent that follows the Armory
      await r.start('beta', '/legion-armory:on-one go');
      await r.start('beta', '/legion-armory:manual-one go');
    });
  }
});

describe('AR5: the off-by-default exemption covers only the fixed list of Claude Code core commands', () => {
  const builtin = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, source: 'claude-builtin', state: 'off', stateIsDefault: true, agents: 'all', description: '', path: null, runsCommandsOnLoad: false, hiddenText: false, ...over }) as never;
  const agent = { id: 'a', skills: 'inherit' as const };
  it('/debug, a built-in off by default, is refused even when the SDK lists it as a command', () => {
    const live = new Set([...CLI_COMMANDS, 'debug']);
    assert.match(refusedCommand([builtin('debug')], agent as never, '/debug', live) ?? '', /switched off/);
  });
  it('/review, a core command that is also a built-in off by default, still runs', () => {
    assert.equal(refusedCommand([builtin('review')], agent as never, '/review', CLI_COMMANDS), undefined);
  });
  it('a built-in the owner turned on is refused for an agent that did not choose it, but /review is not', () => {
    const none = { id: 'a', skills: [] as string[] };
    assert.match(refusedCommand([builtin('debug', { state: 'on', stateIsDefault: false })], none as never, '/debug') ?? '', /not one of this agent's skills/);
    assert.equal(refusedCommand([builtin('review', { state: 'on', stateIsDefault: false })], none as never, '/review'), undefined);
  });
});

describe('AR5: the composer menu offers only what the agent may type', () => {
  it('GET /api/armory/slash lists exactly the names refusedCommand refuses for that agent, and is admin-only', async () => {
    const rig = armoryRig({ agents: [rigAgent('alpha', { skills: [] }), rigAgent('beta')] });
    await prepSkills(rig);
    const a = await rig.call('GET', '/api/armory/slash?agent=alpha');
    const b = await rig.call('GET', '/api/armory/slash?agent=beta');
    assert.ok(a.refused.includes('legion-armory:on-one'), 'alpha (no skills chosen) may not type an Armory skill');
    assert.ok(a.refused.includes('legion-armory:manual-one'));
    assert.ok(!a.refused.includes('compact'), "Claude Code's own /compact stays offered");
    assert.ok(!b.refused.includes('legion-armory:on-one'), 'beta (follows the Armory) may');
    assert.ok(b.refused.includes('legion-armory:off-one'), 'an Armory-off skill is refused for everyone');
    assert.equal(isClientRoute('GET', '/api/armory/slash'), false);
  });
});

describe('AR5: a plugin slash command outside the Armory follows the agent\'s skill choice', () => {
  const live = new Set([...CLI_COMMANDS, 'commit-commands:commit']);
  it('is refused for an agent with its own skill list, runs when the list names it, and for an agent that follows the Armory', () => {
    assert.match(refusedCommand([], { id: 'a', skills: [] } as never, '/commit-commands:commit', live) ?? '', /outside the Armory/);
    assert.equal(refusedCommand([], { id: 'a', skills: ['commit-commands:commit'] } as never, '/commit-commands:commit', live), undefined);
    assert.equal(refusedCommand([], { id: 'a', skills: 'inherit' } as never, '/commit-commands:commit', live), undefined);
    assert.equal(refusedCommand([], { id: 'a', skills: [] } as never, '/compact', live), undefined, 'core commands always run');
  });
});
