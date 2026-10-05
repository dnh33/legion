// Adds a task that stops on a real approval card, so the chat shot shows the guardrail UI live.
// Usage: node approval.mjs <handleFile>
import { readHandle, client } from '../../../scripts/harness/lib.mjs';

const h = client(readHandle(process.argv[2]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await h.resetModel();
await h.script({ agent: 'scout', promptIncludes: 'read the repo' }, [
  { say: 'Reading the repository now.' },
  { tool: 'Bash', input: { command: 'git log --oneline -20' }, as: 'log' },
  { result: 'never reached', costUsd: 0 },
]);
const t = await h.call('POST', '/api/tasks', { agentId: 'scout', prompt: 'read the repo and summarise the release blockers' });
if (t.status !== 201) throw new Error(JSON.stringify(t));
for (let i = 0; i < 40; i++) {
  const a = await h.call('GET', '/api/approvals');
  if ((a.json ?? []).length) break;
  await sleep(250);
}
const approvals = (await h.call('GET', '/api/approvals')).json ?? [];
console.log('task', t.json.id, 'pending approvals', approvals.length, approvals.map((a) => a.toolName + ': ' + a.summary).join(' | '));