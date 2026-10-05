/**
 * Taint: a run that touched outside content (web, shell, another MCP server) is marked, so its Library writes go to the Inbox.
 * Ported from desktop src/core/engine.ts:72-97 (CLEAN_BUILTINS, taintsRun); pure.
 */
import { isLegionModTool } from './tool-names.ts'

/**
 * The tools known not to bring outside content into a run. Desktop src/core/engine.ts:77-83, unchanged. Everything NOT on this
 * list taints the run: an allowlist, so a tool nobody has vouched for is treated as outside content.
 */
export const CLEAN_BUILTINS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'EnterPlanMode',
  // the agent's own plumbing: no network, no other server, nothing that carries someone else's text into the run
  'Skill', 'ToolSearch', 'AskUserQuestion', 'TaskStop', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Config', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronList', 'CronDelete', 'Monitor',
])

/**
 * True when calling this tool taints the run. Desktop src/core/engine.ts:93-97: the mod's own tools do not taint (the desktop's
 * VM-output exceptions, engine.ts:89-91, have no counterpart: the mod has no VM tools), clean built-ins do not, everything else does.
 */
export function taintsRun(toolName: string): boolean {
  if (isLegionModTool(toolName)) return false
  return !CLEAN_BUILTINS.has(toolName)
}
