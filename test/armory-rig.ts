/** Shared fixtures for the Armory tests: a module on a temp data dir and a FAKE Claude home (the real ~/.claude is never read). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import { createArmoryModule } from '../src/core/armory/index.js';
import type { ArmoryModule } from '../src/core/armory/index.js';
import type { SdkProbe } from '../src/core/armory/handshake.js';
import type { ModuleDeps, RouteAdder } from '../src/core/modules.js';
import { defaultConfig } from '../src/shared/config.js';
import type { AgentProfile } from '../src/shared/types.js';

export const mkAgent = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id, name: id, emoji: '*', description: '', systemPrompt: '', model: 'sonnet',
  vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: 'full', mcpServers: [], createdAt: '', updatedAt: '', ...over,
});

export const md = (name: string, description: string, extra = '', body = 'Do the thing.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

export function writeFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A fake ~/.claude with personal skills and plugin installs. */
export interface CcFixture {
  personal?: Record<string, string>;
  commands?: Record<string, string>;
  plugins?: Array<{ key: string; name?: string; scope?: string; skills?: Record<string, string>; commands?: Record<string, string> }>;
  enabled?: Record<string, boolean>;
}
export function fakeClaude(home: string, o: CcFixture = {}): void {
  for (const [n, text] of Object.entries(o.personal ?? {})) writeFile(join(home, 'skills', n, 'SKILL.md'), text);
  for (const [n, text] of Object.entries(o.commands ?? {})) writeFile(join(home, 'commands', `${n}.md`), text);
  const installed: Record<string, unknown[]> = {};
  for (const p of o.plugins ?? []) {
    const root = join(home, 'plugins', 'cache', p.key.replace(/[@/]/g, '_'), '1.0.0');
    mkdirSync(root, { recursive: true });
    if (p.name) writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p.name }));
    for (const [n, text] of Object.entries(p.skills ?? {})) writeFile(join(root, 'skills', n, 'SKILL.md'), text);
    for (const [n, text] of Object.entries(p.commands ?? {})) writeFile(join(root, 'commands', `${n}.md`), text);
    (installed[p.key] ??= []).push({ scope: p.scope ?? 'user', installPath: root, version: '1.0.0' });
  }
  writeFile(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
  writeFile(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: o.enabled ?? {} }));
}

export interface ArmoryRig {
  mod: ArmoryModule;
  dataDir: string;
  home: string;
  agents: Map<string, AgentProfile>;
  config: ReturnType<typeof defaultConfig>;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
  paths: string[];
}

/** The default probe in tests: there is no Claude Code here, so the listing fails and the disk is read (the fallback). */
export const noSdk: SdkProbe = async () => { throw new Error('no Claude Code in tests'); };

export function armoryRig(o: { inherit?: boolean; cc?: CcFixture; agents?: AgentProfile[]; sdkProbe?: SdkProbe } = {}): ArmoryRig {
  const dataDir = tempDir('legion-armory-');
  const home = tempDir('legion-cchome-');
  fakeClaude(home, o.cc);
  const config = defaultConfig();
  config.claude.inheritClaudeCodeSettings = o.inherit ?? true;
  const agents = new Map((o.agents ?? [mkAgent('alpha'), mkAgent('beta')]).map((a) => [a.id, a]));
  const deps = { dataDir, config, store: { getAgent: (id: string) => agents.get(id), listAgents: () => [...agents.values()] } } as unknown as ModuleDeps;
  const mod = createArmoryModule(deps, { claudeHome: home, ttlMs: 0, sdkProbe: o.sdkProbe ?? noSdk });
  const handlers = new Map<string, (c: unknown) => unknown>();
  const paths: string[] = [];
  const add: RouteAdder = (m, p, h) => { paths.push(`${m} ${p}`); handlers.set(`${m} ${p}`, h as (c: unknown) => unknown); };
  mod.routes?.(add);
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const url = new URL(`http://x${path}`);
    const h = handlers.get(`${method} ${url.pathname}`);
    if (!h) throw new Error(`no route ${method} ${url.pathname}`);
    return h({ req: { headers: {} }, body, params: [], url });
  };
  return { mod, dataDir, home, agents, config, call, paths };
}

/** Create a skill of yours and turn it on: a new skill starts off, and these tests are about skills that are on. */
export async function own(r: { call(method: string, path: string, body?: unknown): Promise<any> }, body: Record<string, unknown>): Promise<any> {
  const out = await r.call('POST', '/api/armory/skill', body);
  await r.call('POST', '/api/armory/state', { id: out.id, state: 'on' });
  return { ...out, state: 'on' };
}
