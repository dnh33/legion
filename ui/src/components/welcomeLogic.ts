/** First-run welcome content (pure, tested in test/welcome-flow.test.ts). The screen points a new user at Zealot: a Claude sign-in is all multi-agent work needs, so VMs and the Claude Code connection wait under "Later". */

export interface WelcomeItem { id: 'signin' | 'try' | 'boat' | 'mcp'; title: string; body: string }

/** The one real first task the welcome offers: Zealot hands a question to Scout and reports back, so the first thing a new user sees is the Order at work. */
export const WELCOME_TRY = {
  agentId: 'zealot',
  prompt: 'Ask Scout to find the current LTS version of Node.js with its source, then tell me the answer in one line.',
} as const;

export const WELCOME_STEPS: readonly WelcomeItem[] = [
  { id: 'signin', title: 'Check your Claude sign-in', body: 'Legion uses the account you are signed into Claude Code with. Doctor verifies it without a model call.' },
  { id: 'try', title: 'Give Zealot a first task', body: 'Zealot plans the work, hands it to the agent best placed for it and reports back. This example sends a question to Scout and uses a little of your Claude usage.' },
];

export const WELCOME_LATER: readonly WelcomeItem[] = [
  { id: 'boat', title: 'Cloud VMs for agents (optional)', body: 'Paste a boat.dev key in Settings and agents can start a VM for risky or heavy work. It applies straight away.' },
  { id: 'mcp', title: 'Drive Legion from Claude Code (optional)', body: 'Run this once in a terminal to reach your agents from Claude Code or Cowork. Copy includes your token; it is hidden here.' },
];
