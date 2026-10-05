/**
 * Legion's approval rules on top of Claude Code's permission flow. Ported from desktop src/core/approvals.ts; pure.
 *
 * How the two layers meet (plan §1, §2.1):
 * - The agent's mode sets the baseline through `AgentSpec.permissionMode` (`permissionModeFor`). Claude Code then asks for what
 *   that mode asks for, worded by Claude Code.
 * - Legion's `needsApproval` can only ADD a card on top. `extraAsk` says when it must: the run's effective mode (the stricter of
 *   the agent's mode and a ceiling from whoever started it) wants a card that the agent's own permissionMode would not raise.
 *   That is what the lead's `tool.check` hook answers `ask` for.
 * - `bypassPermissions` is never produced here.
 */
import type { ApprovalMode, ModSettings } from '../../types/index.d.ts'
import { isLegionModTool } from './tool-names.ts'

/** Desktop src/core/approvals.ts:8, unchanged. */
export const READ_ONLY: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent'])
/** Desktop src/core/approvals.ts:9, unchanged. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, 'auto-edits': 1, full: 2 }

/** The stricter (less permissive) of two approval modes. Desktop src/core/approvals.ts:28-32. */
export function stricterMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b
}

/**
 * Whether Legion wants a card for this call in this mode. Desktop src/core/approvals.ts:94-102, with the mod's own tools in place
 * of isLegionTool and without the VM, browser and Blender entries (the mod has none of those).
 *
 * `capped` is kept for parity with the desktop signature. On the desktop it cards the VM tools for a run another party started
 * (approvals.ts:35, 95); the mod has no VM tools, so in the mod it changes nothing.
 */
export function needsApproval(mode: ApprovalMode, toolName: string, _opts: { capped?: boolean } = {}): boolean {
  if (mode === 'full') return false
  if (READ_ONLY.has(toolName) || isLegionModTool(toolName)) return false
  if (EDIT_TOOLS.has(toolName)) return mode === 'ask'
  // Bash, other mcp__*, and unknown tools
  return true
}

function compactJson(v: unknown, max: number): string {
  let s: string
  try { s = JSON.stringify(v) ?? String(v) } catch { s = String(v) }
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** What a call does, at most 400 characters. Desktop src/core/approvals.ts:104-120, without the Blender branch. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const cap = (s: string) => (s.length > 400 ? s.slice(0, 399) + '…' : s)
  if (toolName === 'Bash' && typeof input?.command === 'string') return cap(input.command)
  if ((toolName === 'Write' || toolName === 'Edit') && typeof input?.file_path === 'string') return cap(input.file_path)
  return compactJson(input ?? {}, 400)
}

/** The Claude Code permission modes the mod ever sets. `bypassPermissions` is ruled out (plan §9.6). */
export type ModPermissionMode = 'default' | 'acceptEdits' | 'auto'

/** Legion mode → Claude Code permission mode: ask → default, auto-edits → acceptEdits, full → the person's choice (plan §1, §9.6). */
export function permissionModeFor(mode: ApprovalMode, fullMode: ModSettings['fullMode']): ModPermissionMode {
  if (mode === 'ask') return 'default'
  if (mode === 'auto-edits') return 'acceptEdits'
  return fullMode === 'auto' ? 'auto' : 'acceptEdits'
}

/**
 * Whether Claude Code itself raises a permission ask for this call under `permissionMode` (before the person's own allow rules,
 * which can only make it ask less). A model of Claude Code's documented modes, not a read of its code:
 * - `default` asks for everything outside the read-only set (Legion's own tools are trusted by the mod's hook, not by Claude Code,
 *   so they count as asked here; it makes no difference to extraAsk because Legion never wants a card for them);
 * - `acceptEdits` asks for everything but reads and file edits;
 * - `auto` is treated as "never asks": the classifier may let anything through, so this is the conservative reading for extraAsk
 *   (it makes Legion add its card whenever Legion wants one).
 */
export function engineAsks(permissionMode: ModPermissionMode, toolName: string): boolean {
  if (permissionMode === 'auto') return false
  if (READ_ONLY.has(toolName)) return false
  if (permissionMode === 'acceptEdits') return !EDIT_TOOLS.has(toolName)
  return true
}

/**
 * True when Legion must add a card that Claude Code would not raise: the run's effective mode needs one, and the agent's own
 * permissionMode (set once, from the agent's own mode) does not ask. Example: Builder (`full`) woken under an `ask` ceiling edits
 * a file; its spec runs `acceptEdits`, so only Legion's card stops the edit.
 *
 * `effectiveMode` is `stricterMode(agentMode, ceiling)` for a capped run, else the agent's mode (desktop guardAsk,
 * src/core/approvals.ts:66-83: the ceiling always wins over the agent's own setting).
 */
export function extraAsk(effectiveMode: ApprovalMode, agentMode: ApprovalMode, toolName: string, fullMode: ModSettings['fullMode']): boolean {
  if (!needsApproval(effectiveMode, toolName)) return false
  return !engineAsks(permissionModeFor(agentMode, fullMode), toolName)
}
