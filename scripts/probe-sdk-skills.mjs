/**
 * Does the Claude Agent SDK actually inject ~/.claude/skills when settingSources includes 'user'?
 * That is exactly what Legion passes at engine.ts:703 when inheritClaudeCodeSettings is true (the default).
 * Two tiny calls: one with the setting Legion uses, one control with settingSources: [].
 * Read-only, haiku, ~1 sentence of output each.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const ask = 'List the names of any skills available to you, comma-separated. If you have none, reply exactly: NONE';

async function run(settingSources, label) {
  try {
    const q = query({
      prompt: ask,
      options: {
        model: 'haiku',
        cwd: process.cwd(),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
        settingSources,
        maxTurns: 3,
        includePartialMessages: false,
      },
    });
    let text = '';
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') text = String(msg.result ?? '');
    }
    console.log(`\n--- ${label} (settingSources=${JSON.stringify(settingSources)}) ---`);
    console.log(text.slice(0, 600) || '(empty result)');
  } catch (e) {
    console.log(`\n--- ${label} --- FAILED: ${e?.message?.slice(0, 200)}`);
  }
}

await run(['user', 'project', 'local'], 'AS LEGION SHIPS IT (inheritClaudeCodeSettings: true)');
await run([], 'CONTROL (inheritClaudeCodeSettings: false)');