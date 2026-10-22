/**
 * The words and the small pure rules of the Hermes parts of the window (picker group, thread badge, first-use card, Hermes card, Settings,
 * mode line, usage line). One file so the window, the core and the tests read the same text. Plain words, no dashes, "your computer".
 */
import { runtimeOf } from './runtime.js';
import type { AcpSwitches } from './acp-view.js';

/** What an agent host card says when the agent stops waiting for it (Hermes denies a request nobody answers after 300 s). */
export const ACP_CLOSED_NOTE = 'The agent stopped waiting';
/** What a card says when it is answered after it closed: nothing was sent, nothing was run. */
export const ACP_LATE_NOTE = 'Your answer was not sent, so nothing was run.';

/** The one honest sentence about what Hermes does. It is the picker note, the first-use text and the badge tooltip. */
export const HERMES_NOTE = 'Hermes uses its own tools on your computer: files, commands and the web. Legion shows the questions Hermes asks you, but cannot see most of what it does.';
/** Said once in the agent editor in place of the settings that only reach Claude and provider agents: Skills, Connectors, Shell, .env files and Computer. */
export const HERMES_OWN_TOOLS = 'Hermes uses its own tools and settings, so Skills, Connectors, Shell, .env files and Computer do not apply to it.';
/** Said once in the first-use card (R73): Legion cannot see Hermes read files, so no card ever asks about them. */
export const HERMES_READS = 'It can read any file your account can, Legion\'s data folder included, without asking you.';
export const HERMES_BADGE = 'Hermes \u00b7 acts on your computer';
export const HERMES_GROUP = 'Hermes';
export const HERMES_ITEM_NOTE = 'Uses the model you set in Hermes.';

export const FIRST_USE = { title: 'Before you use Hermes', use: 'Use Hermes', notNow: 'Not now' } as const;
export const HERMES_ASKS = 'Hermes asks';
export const HERMES_NO_COST = 'Hermes does not report cost.';
export const NOT_APPLIED_TO_HERMES = 'Not applied to Hermes agents';

/** The four switches: label, one plain line. All off by default. */
export const SWITCH_COPY: Record<keyof AcpSwitches, { label: string; hint: string }> = {
  disasterStop: { label: 'Stop disaster commands', hint: 'Legion refuses a command that could wipe a drive or your home folder before you are asked.' },
  modeMap: { label: "Match Legion's mode", hint: "Legion sets Hermes's mode from the mode of the Legion agent when a run starts, so a change reaches the next run. Off: Hermes decides what to ask you." },
  stripSkipFlags: { label: "Ignore Hermes's skip-approval settings", hint: 'Legion starts Hermes without the settings that make it approve its own commands.' },
  answerOnce: { label: 'Answer each request once', hint: "Hides Hermes's allow for the session and always options, so every request needs its own answer." },
};
export const SWITCH_ORDER: ReadonlyArray<keyof AcpSwitches> = ['disasterStop', 'modeMap', 'stripSkipFlags', 'answerOnce'];

/** R63: the switches that make Hermes ask less when they change this way: the three safety switches turned off, and Match Legion's mode turned on. */
const LOOSENS_WHEN: Record<keyof AcpSwitches, boolean> = { disasterStop: false, modeMap: true, stripSkipFlags: false, answerOnce: false };
/** What each loosening allows, in one plain line. The native confirmation lists these and nothing else. */
export const LOOSEN_LINES: Record<keyof AcpSwitches, string> = {
  disasterStop: 'Legion will no longer refuse a command that could wipe a drive or your home folder before Hermes asks you.',
  modeMap: "Legion will set Hermes's mode from the Legion agent, so an agent set to Full can make Hermes ask less.",
  stripSkipFlags: "Hermes will start with its own skip-approval settings, so it can approve its own commands.",
  answerOnce: 'Hermes will offer allow for the session and always again, so one answer can cover later requests.',
};
/** The switches in `patch` that change from what they are now to the value that lets Hermes ask less. A tightening, or no change, is not one. */
export function loosenedSwitches(current: AcpSwitches, patch: Partial<AcpSwitches>): Array<keyof AcpSwitches> {
  return SWITCH_ORDER.filter((k) => patch[k] !== undefined && patch[k] !== current[k] && patch[k] === LOOSENS_WHEN[k]);
}

/** What the Contained read-back checks, said once: the core's check result and the Settings switch both use these words. */
export const CONTAINED_CHECKS = "that the Legion profile asks before commands it marks as dangerous, that its tool list for Legion runs is set to file tools, and that it does not borrow your Claude Code login or another coding tool's login";
/** The Contained switch text in Settings. It says what is checked and that the main Hermes sign-in may be used (R53); it claims nothing more. */
export const CONTAINED_SWITCH_HINT = `Runs Hermes in its own profile named legion. Set up and Check read back ${CONTAINED_CHECKS}. It may use your main Hermes sign-in.`;
/** The same text while Contained is off: Set up and Check are not on the page yet, so it does not name them. */
export const CONTAINED_OFF_HINT = `Runs Hermes in its own profile named legion. Once it is on, Legion can read back ${CONTAINED_CHECKS}. It may use your main Hermes sign-in.`;

/**
 * Hermes's short title for a request next to the words the card already shows. The title is only worth a second line when it says something the
 * body does not: a title that is the command, or the command and its description joined, only repeats the body.
 */
export function titleAddsInfo(title: string | undefined, summary: string): boolean {
  const norm = (x: string): string => x.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(title ?? '');
  if (!t) return false;
  const body = norm(summary);
  if (body.includes(t)) return false;
  return t.split(/\s*:\s+/).map((p) => p.trim()).filter(Boolean).some((part) => !body.includes(part));
}

/** Why the Contained switch is off-limits while Hermes is not installed. */
export const CONTAINED_NEEDS_HERMES = 'Contained needs Hermes. Install Hermes first, then come back to set it up.';

export const CUSTOM_ENTRIES_NOTE = 'Other agent hosts are added in the config file, not here.';

/** A Hermes agent: its model value starts with `acp:`. */
export const isAgentHostModel = (m: string | undefined): boolean => runtimeOf(m) === 'acp';

const MODE_WORDS: Record<string, string> = { manual: 'Manual', smart: 'Smart', off: 'Off' };

/**
 * The fixed line that replaces a Legion mode picker for a Hermes agent. With the switch off Legion does not touch Hermes's mode, so the line says
 * so and names Hermes's own mode (read from its settings; "not read yet" before a check). With it on, the Legion picker shows and this line sits under it.
 */
export function hermesModeLine(o: { modeMap: boolean; hermesMode?: string }): string {
  if (o.modeMap) return "Legion sets Hermes's mode from this when a run starts";
  const mode = o.hermesMode && MODE_WORDS[o.hermesMode] ? MODE_WORDS[o.hermesMode] : undefined;
  return `Hermes decides what to ask you. Its mode: ${mode ?? 'not read yet'}`;
}
export const MATCH_MODE_LINK = "Match Legion's mode";
/** The short form of the mode line where a chip or a pill has no room for the sentence (the thread header, the project page). The full line is its tooltip. */
export const HERMES_MODE_CHIP = 'Hermes decides what to ask';
/** The system prompt field of a Hermes agent: Legion puts it in front of the first message it sends. */
export const HERMES_PROMPT_PLACEHOLDER = 'Put in front of the first message Legion sends Hermes.';

/** Whether a thread runs on Hermes: the task when one is open (it ran, or will run, on Hermes), else the agent's own model. An old Claude task of an agent later moved to Hermes is still a Claude task. */
export function threadOnHermes(task: { runtime?: string; model?: string; requestedModel?: string } | undefined, agent: { model?: string } | undefined): boolean {
  if (task) return task.runtime === 'Hermes' || isAgentHostModel(task.model) || (task.runtime === undefined && isAgentHostModel(task.requestedModel));
  return isAgentHostModel(agent?.model);
}

/** The usage line of a Hermes task: tokens when known, then the fixed no-cost sentence (unless the owner entered prices and a cost exists). */
export function hermesUsageLine(t: { status?: string; tokenUsage?: { inputTokens?: number; outputTokens?: number; unknown?: boolean }; costUsd?: number | null }): string {
  const u = t.tokenUsage;
  const noCost = t.costUsd == null ? HERMES_NO_COST : `Cost from your prices: $${t.costUsd.toFixed(4)}.`;
  // tokens arrive when a turn ends: until then a running task has nothing to report yet, which is not the same as "not reported"
  if (u?.inputTokens == null && (t.status === 'running' || t.status === 'queued')) return noCost;
  const tokens = u?.inputTokens != null ? `${u.inputTokens} in / ${u.outputTokens ?? 0} out` : 'tokens not reported';
  const unknown = u?.unknown && u.inputTokens != null ? ' (not all counted)' : '';
  return `${tokens}${unknown}. ${noCost}`;
}

/** Time left on an agent host card. `ended` once it reaches zero: the card then says the agent stopped waiting. */
export function cardCountdown(expiresAt: string | undefined, now: number): { ended: boolean; text: string } | undefined {
  if (!expiresAt) return undefined;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return { ended: true, text: ACP_CLOSED_NOTE };
  const s = Math.ceil(ms / 1000);
  return { ended: false, text: `Closes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` };
}

/** The Hermes model value label for the pill and the editor: `acp:hermes` -> Hermes, `acp:hermes/x` -> Hermes · x. */
export function acpModelLabel(value: string | undefined, hostLabel: (entryId: string) => string | undefined = () => undefined): string | undefined {
  if (runtimeOf(value) !== 'acp') return undefined;
  const rest = value!.slice('acp:'.length);
  const slash = rest.indexOf('/');
  const id = slash < 0 ? rest : rest.slice(0, slash);
  const label = hostLabel(id) ?? (id ? id[0]!.toUpperCase() + id.slice(1) : 'Agent');
  return slash < 0 ? label : `${label} \u00b7 ${rest.slice(slash + 1)}`;
}

/**
 * What stands in for a Legion mode picker. Not a Hermes agent, or Match Legion's mode on: the normal picker (with the line under it for Hermes).
 * Hermes with the switch off: no picker at all, a fixed line (Legion does not set Hermes's mode, so a picker would promise something untrue).
 */
export function agentModeControl(o: { model: string | undefined; modeMap: boolean; hermesMode?: string }): { kind: 'picker'; line?: string } | { kind: 'fixed'; line: string } {
  if (!isAgentHostModel(o.model)) return { kind: 'picker' };
  const line = hermesModeLine({ modeMap: o.modeMap, ...(o.hermesMode ? { hermesMode: o.hermesMode } : {}) });
  return o.modeMap ? { kind: 'picker', line } : { kind: 'fixed', line };
}

/** The first pick of Hermes shows the card once (`firstUseSeen`). */
export const needsFirstUse = (model: string | undefined, firstUseSeen: boolean): boolean => isAgentHostModel(model) && !firstUseSeen;

/** Use Hermes takes the pick; Not now leaves the agent as it was. Either way the card has been met and is not shown again. */
export function firstUseOutcome(choice: 'use' | 'notNow', current: string, picked: string): { model: string; seen: true } {
  return { model: choice === 'use' ? picked : current, seen: true };
}

/** What `/model <name>` does: a Hermes name the owner has not met yet asks (the first-use card, as in the picker), a name with a message after it is a one-off and goes on, anything else sets the model. */
export function slashModelStep(value: string, firstUseSeen: boolean, hasMessage: boolean): 'ask' | 'set' | 'send' {
  if (hasMessage) return 'send';
  return needsFirstUse(value, firstUseSeen) ? 'ask' : 'set';
}
