/** Plain-language explanations for Claude errors people can fix themselves. */
const CREDIT_RE = /credit balance is too low/i;

const CREDITS_LOGIN = 'Claude Code is billing this run to Anthropic API credits, and the balance is empty. This happens when Claude Code is signed in with an Anthropic Console account instead of a Claude Pro or Max plan, or when your Claude Code settings set an API key (ANTHROPIC_API_KEY or apiKeyHelper). To use your Claude plan: open a terminal, run claude, type /logout, then /login and choose your Claude account. Or add credits in the Claude Console. Help -> Doctor shows which login Legion uses.';
const CREDITS_KEY = 'The API key in Settings -> Claude has no credits left. Add credits in the Claude Console, or switch Settings -> Claude to Claude login to use your Claude plan.';

export function explainClaudeError(text: string | undefined, auth: 'claude-login' | 'api-key'): string | undefined {
  if (!text || !CREDIT_RE.test(text)) return undefined;
  return auth === 'api-key' ? CREDITS_KEY : CREDITS_LOGIN;
}
