/**
 * The mod's own tool names, and the one rule that says whether a tool is the mod's.
 *
 * Claude Code names a plugin's tools `mcp__<plugin>__<name>` (claude-code.d.ts:2814-2826, `$.tool.register`). The desktop app
 * spreads its tools over six in-process servers (`legion`, `legion_comms`, `legion_kg`, `legion_board`, `legion_house`,
 * `legion_blender`, src/core/approvals.ts:12); the mod has one server, `legion-mod`. The desktop board tools are called plain
 * `list`, `get`, ... on their own server (src/core/projects/board/tools.ts:55-125), so in the mod's single namespace they carry a
 * `board_` prefix.
 *
 * Pure: no `$`, no I/O.
 */

export const TOOL_PREFIX = 'mcp__legion-mod__'

/**
 * Phase 1: the agent bridge's one mod tool, `agents` (list the order with live states; desktop src/core/engine.ts:106,
 * src/core/bridge.ts:102). The desktop's `ask` and `tell` are Claude Code's own Agent tool in the mod (spike-proven, plan §1):
 * `subagent_type: "legion-mod:<agent id>"`, `run_in_background: false` to ask (it blocks and returns the answer), `true` to tell.
 */
export const BRIDGE_TOOLS = ['agents'] as const

/** The plugin's agent types are `legion-mod:<name>` (claude-code.d.ts:362-366). */
export const AGENT_TYPE_PREFIX = 'legion-mod:'

/** Phase 2: the Library, the same names as the desktop's `legion_kg` server (src/core/kg/tools.ts:80-390). */
export const KG_TOOLS = [
  'kg_recall', 'kg_search', 'kg_get', 'kg_neighbors', 'kg_path', 'kg_subgraph', 'kg_upsert_node', 'kg_capture',
  'kg_wm_set', 'kg_supersede', 'kg_merge', 'kg_link', 'kg_unlink', 'kg_forget', 'kg_lint', 'kg_stats',
] as const

/** Phase 3: bots and rooms, the same names as the desktop's `legion_comms` server (src/core/comms/tools.ts:35-138). */
export const COMMS_TOOLS = [
  'bot_list', 'bot_send', 'room_post', 'room_read', 'room_list', 'handoff', 'room_create', 'room_add_member', 'room_remove_member',
] as const

/** Phase 4: the project board. Desktop `legion_board` tools `list|get|propose|create|update|delete` (board/tools.ts:55-125), prefixed. */
export const BOARD_TOOLS = ['board_list', 'board_get', 'board_propose', 'board_create', 'board_update', 'board_delete'] as const

/** Phase 2: the house context layer, the same names as the desktop's `legion_house` server (src/core/house/tools.ts:46-84). */
export const HOUSE_TOOLS = ['house_list', 'house_recall', 'house_read'] as const

/** Every tool name the mod uses or reserves, without the prefix. */
export const MOD_TOOL_NAMES: readonly string[] = [...BRIDGE_TOOLS, ...KG_TOOLS, ...COMMS_TOOLS, ...BOARD_TOOLS, ...HOUSE_TOOLS]

/** The full wire name of one of the mod's tools. */
export const modTool = (name: string): string => `${TOOL_PREFIX}${name}`

const MOD_TOOL_NAME = /^mcp__legion-mod__[a-z][a-z0-9_]*$/

/**
 * One of the mod's own tools: the exact server name, then a plain tool name. Same rule as desktop src/core/approvals.ts:18-20
 * (isLegionTool): a prefix test alone would also match `mcp__legion-mod__x__run`, a tool of some other server whose name happens
 * to start with `legion-mod__x`; its tool part holds `__`, so it is refused here.
 */
export function isLegionModTool(toolName: string): boolean {
  return MOD_TOOL_NAME.test(toolName) && !toolName.split('__').slice(2).join('__').includes('__')
}

/** Desktop servers whose tools keep their plain name in the mod. */
const SAME_NAME_SERVERS = ['legion_comms', 'legion_kg', 'legion_house'] as const

/**
 * Desktop tool names that have no mod tool of the same kind and are left as they are by `toModToolNames`:
 * - the VM tools (the mod has no boat.dev VMs, plan §1 "Left out") and the Blender bridge (left out too);
 * - `ask` and `tell`, which are the Agent tool in the mod: a name cannot say "Agent with run_in_background false", so the text
 *   that uses them is rewritten by hand (MOD_PREAMBLE does; no roster prompt names them).
 * Callers that build prompts drop or rewrite the lines that name them.
 */
export const DROPPED_DESKTOP_TOOL = /^mcp__legion(?:__vm_[a-z_]*|_blender__[a-z_]*|__ask|__tell)$/

const DESKTOP_TOOL = /mcp__legion(?:_(comms|kg|board|house|blender))?__([a-z][a-z0-9_]*)/g

/**
 * Rewrites the desktop tool names that appear in prompts (roster prompts, the preamble) to the mod's names:
 * `mcp__legion__agents` → `mcp__legion-mod__agents`, `mcp__legion_comms__X`, `mcp__legion_kg__X`, `mcp__legion_house__X` →
 * `mcp__legion-mod__X`, and `mcp__legion_board__X` → `mcp__legion-mod__board_X`.
 * Names in DROPPED_DESKTOP_TOOL (VM, Blender, ask, tell) are left untouched, so a test can find any that slipped through.
 */
export function toModToolNames(text: string): string {
  return text.replace(DESKTOP_TOOL, (whole: string, server: string | undefined, tool: string) => {
    if (DROPPED_DESKTOP_TOOL.test(whole)) return whole
    if (server === undefined) return (BRIDGE_TOOLS as readonly string[]).includes(tool) ? modTool(tool) : whole
    if (server === 'board') return modTool(`board_${tool}`)
    if ((SAME_NAME_SERVERS as readonly string[]).includes(`legion_${server}`)) return modTool(tool)
    return whole
  })
}
