// Seeds the running harness core with real data through the real HTTP API, so screenshots show the actual product.
// Usage: node seed.mjs <handleFile>
import { readHandle, client } from '../../../scripts/harness/lib.mjs';

const h = client(readHandle(process.argv[2]));
const log = (...a) => console.log('·', ...a);
const must = async (method, path, body, auth = 'admin') => {
  const r = await h.call(method, path, body, auth);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json ?? r.text)}`);
  return r.json;
};

// ---------------------------------------------------------------- project
const project = await must('POST', '/api/projects', {
  name: 'Legion 0.3',
  instructions: 'Ship 0.3. Every change needs a test that fails before it passes.',
});
log('project', project.id, project.name);

await must('PUT', `/api/projects/${project.id}/members`, { members: ['zealot', 'builder', 'scout', 'inquisitor', 'scribe', 'sculptor', 'forgemaster'] }, 'native');
await must('PUT', `/api/projects/${project.id}/board/leader`, { leader: 'zealot' });

// ---------------------------------------------------------------- board
const items = [
  { title: 'Ship the Lattice import fix', description: 'A vault with CRLF line endings imported every note as one body. Parse per line and re-import.', status: 'doing', assignee: { kind: 'agent', id: 'builder' }, priority: 'high', labels: ['bug', 'kg'] },
  { title: 'Approval card shows the full command', description: 'Truncate long Bash commands at a safe boundary, not mid-flag.', status: 'review', assignee: { kind: 'agent', id: 'builder' }, priority: 'normal', labels: ['ui'] },
  { title: 'Blender bridge: run headless first', description: 'Default to the local headless binary, fall back to the VM when Blender is not installed here.', status: 'done', assignee: { kind: 'agent', id: 'sculptor' }, priority: 'normal', labels: ['3d'] },
  { title: 'Write the 0.3 release notes', description: 'Owner voice: what changed, what is still unverified on a real PC.', status: 'backlog', assignee: { kind: 'owner' }, priority: 'normal', labels: ['docs'] },
  { title: 'Audit every admin route', description: 'Default deny is only real if the route list is right. Check all 60-odd.', status: 'blocked', assignee: { kind: 'agent', id: 'inquisitor' }, priority: 'high', labels: ['security'] },
  { title: 'Idle VM reaper: back off after 3 stops', description: 'A flaky sandbox gets stopped and restarted in a loop. Back off.', status: 'backlog', priority: 'low', labels: ['vm'] },
];
const made = [];
for (const i of items) made.push(await must('POST', `/api/projects/${project.id}/board/items`, i));
log('board items', made.length);

// ---------------------------------------------------------------- knowledge graph
const nodes = [
  { id: 'n-dec-1', type: 'decision', title: 'Blender runs headless by default', body: 'A local headless Blender is faster and needs no VM. The VM is the fallback, not the default.', tags: ['blender', 'decision'], scope: 'shared' },
  { id: 'n-dec-2', type: 'decision', title: 'Notes a bot writes after a tool call wait in the Inbox', body: 'Anything produced after touching the web, a shell or an outside tool is untrusted until the owner accepts it.', tags: ['kg', 'trust'], scope: 'shared' },
  { id: 'n-pat-1', type: 'pattern', title: 'Gate every release with the four commands', body: 'build:ts, test, typecheck, build:ui. One at a time, exact counts reported.', tags: ['release'], scope: 'shared' },
  { id: 'n-mis-1', type: 'mistake', title: 'Piping a backgrounded npm build killed its children', body: '`| tail -N` makes the child stdin a non-tty. The build "failed" for a reason that had nothing to do with the code.', tags: ['windows', 'release'], scope: 'shared' },
  { id: 'n-mis-2', type: 'mistake', title: 'Deduplicating two identical-looking helpers broke the suite', body: 'typecheck passed. The extractions were not semantically identical.', tags: ['refactor'], scope: 'shared' },
  { id: 'n-pat-2', type: 'pattern', title: 'A test that has never been seen red is not evidence', body: 'Mutate the source, watch it fail, revert.', tags: ['testing'], scope: 'shared' },
  { id: 'n-obs-1', type: 'lesson', title: 'boat.dev free trial refuses the large sandbox size', body: 'So Builder ships as "default" and the owner picks "large" deliberately.', tags: ['vm', 'boat'], scope: 'shared' },
  { id: 'n-obs-2', type: 'lesson', title: 'Handoff notes go stale within a day', body: 'The S5b handoff was telling the next agent to redo merged work. Mark it superseded, do not delete it.', tags: ['process'], scope: 'shared' },
  { id: 'n-dec-3', type: 'decision', title: 'Mainnet money ships behind a switch that is off', body: 'The code exists, the switch is off, and only the owner turns it on in the app.', tags: ['bsv', 'safety'], scope: 'shared' },
  { id: 'n-obs-3', type: 'lesson', title: 'A house-layer trust record was forgeable', body: 'Found by the Zealot test in 0.2.3-f. The record was writable from an agent context.', tags: ['security', 'house'], scope: 'shared' },
];
for (const n of nodes) await must('POST', '/api/kg/nodes', n);
const edges = [
  ['n-dec-1', 'n-obs-1', 'depends_on'], ['n-dec-2', 'n-mis-1', 'caused'], ['n-pat-1', 'n-mis-1', 'prevents'],
  ['n-pat-2', 'n-mis-2', 'prevents'], ['n-dec-3', 'n-obs-3', 'relates_to'], ['n-obs-2', 'n-pat-1', 'relates_to'],
  ['n-obs-3', 'n-dec-2', 'relates_to'], ['n-pat-2', 'n-obs-2', 'prevents'],
];
for (const [from, to, rel] of edges) await must('POST', '/api/kg/edges', { from, to, rel });
log('kg nodes', nodes.length, 'edges', edges.length);

// ---------------------------------------------------------------- rooms
const room = await must('POST', '/api/rooms', {
  name: '0.3 release',
  members: ['zealot', 'builder', 'inquisitor', 'scribe'],
  strategy: 'round-robin',
  lead: 'zealot',
  projectId: project.id,
});
log('room', room.id);
await must('POST', `/api/rooms/${room.id}/messages`, { text: 'Release cut is 0.3-f. Marshal: what is still unverified on a real PC?' });
await h.resetModel();
await h.script({ agent: 'builder' }, [
  { say: 'Two things. The updater never ran against a real signed release, and the Blender bridge has never touched a real Blender. Everything else is covered by the harness.' },
  { result: 'Two open items, both need your PC.', costUsd: 0.02 },
]);
await must('POST', `/api/rooms/${room.id}/messages`, { text: 'builder: confirm' });
await h.call('POST', '/api/tasks', { agentId: 'builder', prompt: 'confirm' });
await new Promise((r) => setTimeout(r, 2500));

// ---------------------------------------------------------------- chat thread with an approval card
await h.resetModel();
await h.script({ agent: 'builder', promptIncludes: 'cut 0.3' }, [
  { say: 'On it. Cutting the tag, then the packaged build.\n\nFirst the tag.' },
  { tool: 'Bash', input: { command: 'git tag -a v0.3.0 -m "0.3.0" && git push origin v0.3.0' }, as: 'tag' },
  { wait: 400 },
  { say: 'Tag is up. Now the package build, which takes a few minutes.' },
  { tool: 'Bash', input: { command: 'node scripts/release-package.mjs --out dist-pkg' }, as: 'pkg' },
  { result: 'v0.3.0 packaged and verified.', costUsd: 0.11 },
]);
const t = await must('POST', '/api/tasks', { agentId: 'builder', prompt: 'cut 0.3 and package it' });
log('task', t.id, t.status);
await new Promise((r) => setTimeout(r, 1200));

console.log('SEEDED', JSON.stringify({ project: project.id, room: room.id, task: t.id }));