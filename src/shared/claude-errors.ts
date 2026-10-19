/** Plain-language explanations for Claude errors people can fix themselves. */
const CREDIT_RE = /credit balance is too low/i;

const CREDITS_LOGIN = 'Claude Code is billing this run to Anthropic API credits, and the balance is empty. This happens when Claude Code is signed in with an Anthropic Console account instead of a Claude Pro or Max plan, or when your Claude Code settings set an API key (ANTHROPIC_API_KEY or apiKeyHelper). To use your Claude plan: open a terminal, run claude, type /logout, then /login and choose your Claude account. Or add credits in the Claude Console. The Doctor button in the title bar shows which login Legion uses.';
const CREDITS_LOGIN_SWITCH = ' Or, to pay with API credits on purpose, turn on Settings -> Claude -> Allow API credit billing.';
const CREDITS_LOGIN_ALLOWED = ' Your Settings allow API credit billing, so add credits in the Claude Console to keep going.';
const CREDITS_KEY = 'The API key in Settings -> Claude has no credits left. Add credits in the Claude Console, or switch Settings -> Claude to Claude login to use your Claude plan.';

export function explainClaudeError(text: string | undefined, auth: 'claude-login' | 'api-key', allowApiBilling = false): string | undefined {
  if (!text || !CREDIT_RE.test(text)) return undefined;
  return auth === 'api-key' ? CREDITS_KEY : allowApiBilling ? CREDITS_LOGIN + CREDITS_LOGIN_ALLOWED : CREDITS_LOGIN + CREDITS_LOGIN_SWITCH;
}

/** The outcome subtype of a run stopped at start because Claude Code would bill API credits under a plan-only Claude login. */
export const API_BILLING_BLOCKED = 'api_billing_blocked';

/** The outcome subtype of a plan-only run stopped at start because the account check did not answer in time or failed. */
export const PLAN_CHECK_FAILED = 'plan_check_failed';
export const PLAN_CHECK_FAILED_TEXT = 'This run did not start: Legion could not confirm that Claude Code will use your Claude plan (the account check did not answer). Try again. If it keeps happening, open the Doctor button in the title bar.';

/** The task's error when a plan-only run would bill API credits. `source` is the SDK init message's apiKeySource, never a key value. */
export function apiBillingBlockedText(source: string): string {
  return `This run did not start: Claude Code would bill Anthropic API credits (key source: ${source}), and Legion's Claude login uses your Claude plan only. To use your plan: run claude in a terminal, type /logout, then /login and choose your Claude account. If you mean to pay with API credits, turn on Settings -> Claude -> Allow API credit billing.`;
}
