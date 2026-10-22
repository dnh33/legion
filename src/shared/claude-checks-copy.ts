// The words about "Claude agents follow Claude's own permission checks" (0.3.6): the switch on the Gates page, what each preset means for a Claude agent,
// the help text, the one-time notice, the first-run sentence and the fallback line. One place, so the page, the run chip, the thread note and the
// activity log say the same thing. Plain words; no em dashes.
import type { Preset } from './gates-registry.js';

/** Who had no Claude checker: the agent and the model, each known or not. */
export interface CheckerWho { agent?: string; model?: string }
/** A Claude model id as a person says it (`claude-haiku-4-5-20251001` reads "Claude Haiku 4.5"); anything else stays as it is. */
export function friendlyModel(id: string): string {
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  const a = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-(?:\d{8}|latest))?$/.exec(id);
  if (a) return `Claude ${cap(a[1]!)} ${a[2]}${a[3] ? `.${a[3]}` : ''}`;
  const b = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-(?:\d{8}|latest))?$/.exec(id);
  if (b) return `Claude ${cap(b[3]!)} ${b[1]}${b[2] ? `.${b[2]}` : ''}`;
  return id;
}
const joinNames = (names: string[]): string => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
/** Said once when Claude's checker (Smart) could not be used for a run: before the run (the model has none) or by the init message. It names the agent and the model. */
export function checkerFallbackLine(who: readonly CheckerWho[] = []): string {
  const names = [...new Set(who.map((w) => (w.agent && w.model ? `${w.agent} on ${friendlyModel(w.model)}` : (w.model ? friendlyModel(w.model) : (w.agent ? `the model ${w.agent} uses` : '')))).filter(Boolean))];
  return `Claude's checker is not available for ${names.length ? joinNames(names) : 'the model in use'}, so Claude asks you as in Ask.`;
}
/** The run chip when a Smart run had no checker: one chip, in place of "Runs as Smart" plus a second one. The full line is its hover and its screen-reader text. */
export function checkerChipText(model?: string): string { return `Smart: Claude asks as in Ask (no checker for ${model ? friendlyModel(model) : 'its model'})`; }

export const CLAUDE_CHECKS_LABEL = "Claude agents follow Claude's own permission checks";
export const CLAUDE_CHECKS_LINE = 'Claude decides about its own tools in every preset. Legion still keeps your Block rules, its own files and its own tools, and the stop for catastrophic commands.';
export const OTHER_PROVIDERS_LINE = "Other providers (OpenRouter, DeepSeek, custom) use Legion's own checks.";
export const CLAUDE_CHECKS_OFF_LINE = "Off: Legion's own cards and Smart judge decide about Claude's tools, as before this update.";
export const LEARN_MORE = 'Learn more';
export const LEARN_LESS = 'Hide details';
/** The Gates rules list: an Allow rule would skip Claude's own checker, so it does not answer Claude's prompts. */
export const ALLOW_RULES_LINE = "Legion's Allow rules do not answer Claude's own prompts for Claude agents. Block and Ask rules still apply.";

/** What Claude does in each preset, in plain words (measured with Claude Code 2.1.296, see the probe notes). */
export const CLAUDE_PRESET_LINES: Record<Preset, string> = {
  ask: 'Claude asks before it edits files or runs commands. Reading files and simple listing commands run without asking.',
  'accept-edits': 'File edits and file commands in your project run without asking, including deleting and moving files (rm, mv, cp). Commands like git push still ask.',
  smart: "Claude's own checker decides. Anything it is unsure about comes to you.",
  bypass: "Claude runs everything without asking, except deleting your project folder or a folder above it, which still asks. Your Block rules and Legion's stop on disastrous commands always apply.",
};

/** The help panel behind "Learn more": four short groups. */
export const LEARN_MORE_GROUPS: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
  { title: 'What Legion still does', lines: [
    'Your Block rules hold in every preset.',
    'A command that could wipe a drive or your home folder is stopped.',
    "Legion's own files (keys, settings, its program folder) stay protected.",
    'Legion\'s own tools (BSV, Blender, GitHub writes) keep their own cards.',
    'A folder with its own Claude Code settings still needs your trust first.',
  ] },
  { title: 'What Legion no longer does for Claude agents', lines: [
    "Legion's Smart judge, its new-site check, and its cards for protected files, secret files and deleting the project folder.",
    'Claude has its own checks for these.',
  ] },
  { title: 'Good to know', lines: [
    "Claude's checker can miss things. It is not a security boundary.",
    'In Smart, the checker may use some extra Claude usage.',
    'If a model has no checker, Claude asks you as in Ask, and the run says so.',
  ] },
];

/** The one-time notice after the update. */
export const CLAUDE_NOTICE = {
  text: "Claude agents now follow Claude's own permission checks in every preset. It is on. Claude decides about its own tools; Legion still keeps your Block rules, its own files and tools, and its stop for catastrophic commands. Accept edits: for Claude agents, file edits and file commands in your project run without asking, including deleting and moving files (rm, mv, cp). Commands like git push still ask. Other providers keep Legion's checks. You can turn this off in Settings, Gates.",
  open: 'Open Gates',
  dismiss: 'Got it',
} as const;

/** The first-run screen: one sentence for Claude agents. */
export const FIRST_RUN_CLAUDE_LINE = "Claude agents follow Claude's own permission checks in every choice below. Other providers use Legion's own checks.";
