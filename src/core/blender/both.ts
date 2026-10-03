/**
 * "Use both backends at once" (claude/plan-blender-local-first.md section 15). OFF unless the owner turns it on; with it off nothing in this file runs
 * and exactly one live backend is used, as before.
 *
 *   - The official Blender Lab MCP is the MAIN backend, the community add-on the SECOND. The Sculptor sees ONE merged tool list.
 *   - Where both offer a capability (running code, inspect, screenshot, docs) only the MAIN backend's tool is used. The second backend's tools
 *     appear only where the main has none, named `community:<name>`; the main's own read-only extras appear as `official:<name>`.
 *   - Each add-on listens on its OWN port. Legion probes that they differ and are free before it starts anything, never relies on SO_REUSEADDR
 *     (on Windows it can let two servers share a port silently), and checks what answers on each port before using it. A taken port or the
 *     wrong backend on a port fails closed with a plain message.
 *
 * What it does NOT do, plainly: both add-on sockets still have no password, so any program on this computer can talk to either port (see
 * docs/BLENDER.md); the identity check tells the two add-ons apart, it does not authenticate a caller; and a program that grabs a port between
 * the check and the connection still wins that race.
 */
import type { BlenderConfig } from '../../shared/blender.js';
import { COMMUNITY_EXTRAS, looksLikeAddon, looksLikeAddonInfo } from './backends/community.js';
import type { CommunityBackend } from './backends/community.js';
import type { OfficialBackend } from './backends/official.js';
import type { BackendResult, BlenderBackend, ExtraTool } from './backend.js';
import { fail } from './backend.js';

/** The tool-by-tool routing table (the same text is in the plan and docs/BLENDER.md; test/blender-both.test.ts compares them). */
export interface Route { tool: string; backend: 'official' | 'community' | 'legion'; note: string }
export const ROUTING: readonly Route[] = [
  { tool: 'blender_exec', backend: 'official', note: 'the community add-on\'s execute_code is NOT offered; same static check, card, audit and busy rules' },
  { tool: 'blender_inspect', backend: 'official', note: 'the scene summary and one-object detail' },
  { tool: 'blender_screenshot', backend: 'official', note: 'the viewport image' },
  { tool: 'blender_docs', backend: 'official', note: 'API docs search; the community add-on has none' },
  { tool: 'blender_status', backend: 'legion', note: 'where scripts go, which add-on answers on which port, which extras are available' },
  { tool: 'blender_tools', backend: 'legion', note: 'the merged list of extra read-only tools (source:name)' },
  { tool: 'blender_tool official:<name>', backend: 'official', note: 'only tools the official server marks read-only that take no code, path, file or address' },
  { tool: 'blender_tool community:node_type', backend: 'community', note: 'describe_node_type; hidden when the official server has an equivalent' },
  { tool: 'blender_tool community:api_lookup', backend: 'community', note: 'bpy_api_lookup; hidden when the official server has an equivalent' },
  { tool: 'blender_tool community:scene_snapshot', backend: 'community', note: 'get_world_state_snapshot; hidden when the official server has an equivalent' },
  { tool: 'blender_tool community:scene_items', backend: 'community', note: 'list_scene_items; hidden when the official server has an equivalent' },
  { tool: 'blender_asset_search / blender_asset_get', backend: 'legion', note: 'Legion fetches Poly Haven itself (card, hash, quarantine, taint); the add-on\'s own download, generator, export, telemetry and premium commands are never offered' },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------------------------------------------

export interface BothPorts { official: number; community: number }

/** The two ports from config, or why they cannot be used. They must be different; nothing else is assumed. */
export function bothPorts(cfg: Pick<BlenderConfig, 'port' | 'advanced'>): { ok: true; ports: BothPorts } | { ok: false; error: string } {
  const official = cfg.port;
  const community = cfg.advanced.both.communityPort;
  if (official === community) return { ok: false, error: `Both add-ons are set to port ${official}. Each needs its own port: change the community port (config blender.advanced.both.communityPort) or the official port in Settings. Nothing was started.` };
  return { ok: true, ports: { official, community } };
}

/** Before Legion starts Blender with both servers: both ports must be free (nothing accepts a connection). Fails closed with the port that is taken. */
export async function ensureFreePorts(host: string, ports: BothPorts, probe: (host: string, port: number) => Promise<boolean>): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [label, port] of [['official', ports.official], ['community', ports.community]] as const) {
    if (await probe(host, port).catch(() => true)) return { ok: false, error: `Port ${port} (the ${label} add-on) is already in use by another program or an earlier Blender. Nothing was started. Close it, or choose another port.` };
  }
  return { ok: true };
}

export type SideState = 'ok' | 'down' | 'wrong';
export interface BothVerdict {
  official: { state: SideState; note: string };
  community: { state: SideState; note: string };
}
export interface VerifyDeps {
  probe: (host: string, port: number) => Promise<boolean>;
  /** One JSON request to the community protocol (src/core/blender/tcp.ts jsonRequest). */
  request: (host: string, port: number, payload: unknown, opts: { timeoutMs: number }) => Promise<unknown>;
}
/** Text from a server, one line, no control characters. */
const plain = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unwrap = (raw: unknown): unknown => (isObj(raw) && raw.status === 'success' && 'result' in raw ? raw.result : undefined);

/** Does the listener on this port answer like the community add-on? (`get_addon_info` first, the older `get_scene_info` shape as a fallback.) */
async function answersAsCommunity(host: string, port: number, d: VerifyDeps, timeoutMs: number): Promise<boolean> {
  try {
    if (looksLikeAddonInfo(unwrap(await d.request(host, port, { type: 'get_addon_info', params: {} }, { timeoutMs })))) return true;
    return looksLikeAddon(unwrap(await d.request(host, port, { type: 'get_scene_info', params: {} }, { timeoutMs })));
  } catch { return false; }
}

/**
 * What is on each port right now. community: nothing = down; the community add-on = ok; anything else = wrong (something else owns the port).
 * official: nothing = down; the COMMUNITY add-on answering there = wrong (the two are swapped or one port is shared); anything else counts as ok.
 * That only RULES OUT the community add-on on that port: nothing here identifies the official add-on itself (the MCP server process Legion starts
 * talks to whatever owns the port). A reply to a stray JSON request on the official port is all this sends there (timeout 1.5 s); its protocol is not assumed.
 */
export async function verifyBoth(host: string, ports: BothPorts, d: VerifyDeps): Promise<BothVerdict> {
  const out: BothVerdict = { official: { state: 'down', note: '' }, community: { state: 'down', note: '' } };
  if (!(await d.probe(host, ports.community).catch(() => false))) out.community = { state: 'down', note: `Nothing is listening on port ${ports.community}. Start the community add-on's server in Blender (BlenderMCP tab) on that port.` };
  else if (await answersAsCommunity(host, ports.community, d, 4000)) out.community = { state: 'ok', note: `The community add-on answers on port ${ports.community}.` };
  else out.community = { state: 'wrong', note: `Something is listening on port ${ports.community} but it does not answer like the community add-on. It was not used. Close the other program or change the community port.` };

  if (!(await d.probe(host, ports.official).catch(() => false))) out.official = { state: 'down', note: `Nothing is listening on port ${ports.official}. Start the official add-on's server in Blender (its sidebar panel) on that port.` };
  else if (await answersAsCommunity(host, ports.official, d, 1500)) out.official = { state: 'wrong', note: `The community add-on is answering on port ${ports.official}, which is the OFFICIAL add-on's port. Nothing was used. Give each add-on its own port.` };
  else out.official = { state: 'ok', note: `Something other than the community add-on is listening on port ${ports.official}. Legion cannot tell whether it is the official add-on: it only rules out the community add-on there.` };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The merged backend
// ---------------------------------------------------------------------------------------------------------------------------------

export interface BothDeps extends VerifyDeps {
  main: OfficialBackend | BlenderBackend;
  second: CommunityBackend;
  host: string;
  ports: BothPorts;
}

/**
 * The backend the guard sees in "both" mode. kind is `official` (the main). exec, inspect, screenshot and docs go to the main backend and to nothing
 * else, so there is exactly one code-execution path. The second backend is reached only through callExtra, for the fixed read-only list above.
 */
export class BothBackend implements BlenderBackend {
  readonly kind = 'official' as const;
  verdict: BothVerdict | null = null;
  private verifiedAt = 0;
  constructor(private readonly d: BothDeps, private readonly now: () => number = Date.now) {}

  /** Fails closed when a port is taken or the wrong add-on answers (either side). A community add-on that is simply not running is not fatal: its extras say so. */
  async connect(): Promise<void> {
    // The guard connects before every call. The identity probes (one of them goes to the official port) run on the first connect, after the main
    // connection was lost, and then at most once a minute, not on every tool call.
    const v0 = this.verdict;
    const fresh = v0 !== null && v0.official.state !== 'wrong' && v0.community.state !== 'wrong' && this.d.main.isConnected() && this.now() - this.verifiedAt < 60_000;
    if (!fresh) {
      const v = await verifyBoth(this.d.host, this.d.ports, this.d);
      this.verdict = v;
      this.verifiedAt = this.now();
      if (v.official.state === 'wrong') throw new Error(v.official.note);
      if (v.community.state === 'wrong') throw new Error(v.community.note);
    }
    await this.d.main.connect();
  }
  isConnected(): boolean { return this.d.main.isConnected(); }
  exec(script: string, opts?: { timeoutMs?: number }): Promise<BackendResult> { return this.d.main.exec(script, opts); }
  inspect(o: { object?: string }): Promise<BackendResult> { return this.d.main.inspect(o); }
  screenshot(o: { maxSize?: number }): Promise<BackendResult> { return this.d.main.screenshot(o); }
  docs(q: string): Promise<BackendResult> { return this.d.main.docs(q); }
  toolNames(): string[] { return this.d.main.toolNames?.() ?? []; }
  async close(): Promise<void> { await this.d.main.close(); await this.d.second.close(); }

  private officialExtras(): ExtraTool[] {
    const m = this.d.main as Partial<OfficialBackend>;
    return (m.extraTools?.() ?? []).map((t) => ({
      name: `official:${t.name}`, source: 'official' as const, description: plain(t.description ?? '', 300),
      args: Object.fromEntries(Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => [plain(k, 40), plain(String(v?.type ?? 'value'), 20)])),
    }));
  }

  /** The merged list: the main's read-only extras, then the second's fixed extras that the main has no equivalent of. */
  catalog(): ExtraTool[] {
    // only tools the Sculptor can actually call count as "the main already has this"
    const mainNames = (this.d.main as Partial<OfficialBackend>).callableNames?.() ?? [];
    const second = COMMUNITY_EXTRAS.filter((e) => !mainNames.some((n) => e.officialHas.test(n)))
      .map((e) => ({ name: `community:${e.key}`, source: 'community' as const, description: e.description, args: e.args }));
    return [...this.officialExtras(), ...second];
  }

  async callExtra(name: string, args: Record<string, unknown>): Promise<BackendResult> {
    const entry = this.catalog().find((e) => e.name === name);
    if (!entry) return fail(`"${name}" is not in the tool list. Call blender_tools to see what is available.`);
    if (entry.source === 'official') return (this.d.main as OfficialBackend).callExtra(name.slice('official:'.length), args);
    if (this.verdict?.community.state !== 'ok') {
      // re-check once: the user may have started the add-on since the last connect
      this.verdict = await verifyBoth(this.d.host, this.d.ports, this.d);
      if (this.verdict.community.state !== 'ok') return fail(this.verdict.community.note);
    }
    return this.d.second.callExtraByKey(name.slice('community:'.length), args);
  }
}
