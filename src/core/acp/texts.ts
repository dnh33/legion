/**
 * The words a person reads when an agent host run (Hermes) cannot start or does not finish. Plain words, no dashes, "your computer".
 * The engine picks one by reason; the Doctor reuses the same sentences for the same causes.
 */
import type { AcpRefusalReason } from './session.js';

export const HERMES_CWD_TEXT = "Hermes agents need a project folder outside Legion's data folder. Choose a folder for this agent.";
export const HERMES_WATCHDOG_TEXT = 'Hermes stopped answering, so Legion stopped this task. Try again, or check Hermes in Doctor.';

/** What each reason the agent gave means for the person. The agent's own words are kept out of the headline and can be copied from the log. */
export function refusalText(reason: AcpRefusalReason): string {
  switch (reason) {
    case 'acp-version': return 'Hermes speaks a different version of the agent protocol than Legion does. Update Hermes or Legion, then try again.';
    case 'no-policy': return 'Hermes cannot take Legion\'s settings for a run. Update Hermes, then try again.';
    case 'protocol-mismatch': return 'Hermes and its background helper are on different versions. Update Hermes and restart it, then try again.';
    case 'breakaway': return 'Hermes could not start its background helper on your Windows setup. Start Hermes once from its own app, then Legion can join it.';
    case 'auth': return 'Hermes has no model provider set up yet. Run Hermes setup, then try again.';
    case 'not-found': return 'Hermes no longer has that conversation.';
  }
}

/** Hermes refused the tool list Legion sent (`acp_mcp_policy_*`): not a reason session.ts knows, so the engine reads the agent's text. */
export function toolPolicyText(raw: string): string | undefined {
  if (/acp_mcp_policy_unavailable/.test(raw)) return 'Hermes does not support the tool list Legion sends with each run. Update Hermes, then try again.';
  if (/acp_mcp_policy_conflict/.test(raw)) return 'Hermes is still holding the earlier tool list for that conversation, so Legion\'s tools cannot be changed now. Try again in a moment, or start a new conversation.';
  return undefined;
}

export const HERMES_NOT_ALLOWED_TEXT = 'You did not allow this, so Hermes was not started.';
export const HERMES_MAX_TOKENS_TEXT = 'Hermes ran out of room to answer. Ask again, or split the task into smaller steps.';
export const HERMES_REFUSED_TEXT = 'Hermes declined to continue this task.';
export const HERMES_BASELINE_TEXT = 'Hermes does not say how many tokens this earlier conversation used, so this first turn is not counted.';
export const HERMES_SESSION_GONE_TEXT = 'Hermes no longer has the earlier conversation, so Legion started a new one with your message.';
/** The stored conversation was let go because Hermes would not take Legion's tools on it: nothing was lost yet, but the next message cannot continue it. */
/** A custom entry that is not tested with Legion never runs Full or Bypass. */
export const HERMES_UNTESTED_TEXT = 'Hermes is not tested with Legion yet, so it runs in Ask mode: Full access and Bypass are not used for it. Every request it makes asks you first.';

/** These texts name Hermes. An entry that is another agent host has its own label, and the texts use that one. */
export const named = (text: string, label: string): string => (label === 'Hermes' ? text : text.split('Hermes').join(label));

/** The thread line for a command Legion refused on its own (the disaster stop). */
export const disasterNote = (why: string): string => `Legion refused a command Hermes asked to run. ${why}`;
