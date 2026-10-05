/**
 * The agents the mod starts with: the desktop's three frozen defaults, then the muster roster. Pure.
 *
 * The defaults live in desktop src/core/store.ts seedDefaults (store.ts:125-146), which is not vendored (it does file I/O), so
 * their fields are copied here; a spec reads store.ts and checks each copied string is identical. The roster is the vendored
 * desktop file (vendor/legion/src/core/roster.ts), used as is.
 *
 * Prompts go through toModToolNames, so the desktop tool names in them become the mod's. The roster's own words are kept, even
 * where they mention a VM or the Blender bridge; the mod's preamble tells every agent those are not available here.
 */
import type { AgentView, ApprovalMode } from '../../types/index.d.ts'
import { ROSTER } from '../../vendor/legion/src/core/roster.ts'
import { toModToolNames } from './tool-names.ts'

type Seed = { id: string; name: string; emoji: string; model: string; approval: ApprovalMode; description: string; systemPrompt: string; requires?: string }

/** Desktop src/core/store.ts:128-146, the three frozen defaults: the fields the mod uses, copied character for character. */
export const DESKTOP_DEFAULTS: readonly Seed[] = [
  {
    id: 'zealot', name: 'Zealot', emoji: '✠', model: 'auto', approval: 'auto-edits',
    description: 'Lead agent of the Legion: takes any request, delegates to the order.',
    systemPrompt: 'You are the lead agent. Handle general requests directly and keep answers concise.\nFor big or specialised work, break it into steps and suggest delegating to Builder (coding) or Scout (research).\nUse your cloud VM only when the task really needs it.',
  },
  {
    id: 'builder', name: 'Builder', emoji: '⌘', model: 'auto', approval: 'full',
    description: 'Coding and building; prefers its VM for risky work.',
    systemPrompt: 'You write, run and debug code. Make small, verifiable changes and run tests before reporting done.\nPrefer your cloud VM for untrusted code, heavy installs, long builds and GUI/browser work.\nStop the VM when you are finished with it.',
  },
  {
    id: 'scout', name: 'Scout', emoji: '◎', model: 'sonnet', approval: 'ask',
    description: 'Research, reading and summarising.',
    systemPrompt: 'You research, read and summarise. Cite sources and separate facts from guesses.\nKeep summaries tight: lead with the answer, then supporting detail.\nDo not modify files unless explicitly asked.',
  },
]

/** Capabilities the mod leaves out; an agent that requires one is hidden (the Assayer requires BSV, plan §1 "Left out"). */
const MISSING_CAPABILITIES: ReadonlySet<string> = new Set(['bsv'])

/**
 * Roster agents whose whole role is a tool the mod leaves out (plan §1 "Left out": Blender). The Sculptor works only through the
 * Blender bridge, so it is hidden like the Assayer. Its desktop entry has no `requires`, hence this list.
 */
const LEFT_OUT_ROLES: ReadonlySet<string> = new Set(['sculptor'])

function view(s: Seed): AgentView {
  return {
    id: s.id,
    name: s.name,
    glyph: s.emoji,
    description: s.description,
    systemPrompt: toModToolNames(s.systemPrompt),
    model: s.model,
    approval: s.approval,
    isRoster: true,
    isHidden: (s.requires !== undefined && MISSING_CAPABILITIES.has(s.requires)) || LEFT_OUT_ROLES.has(s.id),
  }
}

/** The 13 roster agents in the desktop's order (store.ts:128-147): zealot, builder, scout, then ROSTER; Assayer and Sculptor hidden. Fresh objects each call. */
export function seedAgents(): AgentView[] {
  return [...DESKTOP_DEFAULTS, ...ROSTER].map(view)
}
