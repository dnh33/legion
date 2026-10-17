/**
 * Parts the skill finder eval and the catalog-size sweep share: the seeded shuffle, the paired statistics, the safe file write and
 * the one-turn "which skill does the model call" probe. Nothing here reads private data or prints a prompt.
 */
import { unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export const round = (x) => Math.round(x * 10000) / 10000;

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates shuffle, then the first n. The same input and seed always give the same list. */
export function sample(list, n, seed) {
  const arr = list.slice();
  const rnd = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/** Writes a fresh file: an existing file or planted link at the path is removed first, and 'wx' refuses to follow anything that appears. */
export function writeFresh(path, data) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  writeFileSync(path, data, { flag: 'wx' });
}

/** 95% Wilson interval for x of n. */
export function wilson(x, n) {
  if (!n) return [null, null];
  const z = 1.96;
  const p = x / n;
  const den = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / den;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [round(c - h), round(c + h)];
}

const logChoose = (n, k) => {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
};

/** Exact two-sided McNemar p-value from the two discordant counts. */
export function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let p = 0;
  for (let k = 0; k <= Math.min(b, c); k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** Adds up the usage of several turns. Each turn is the usage object of one assistant message. */
export function sumUsage(list) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const u of list) {
    t.input += u?.input_tokens ?? 0;
    t.cacheRead += u?.cache_read_input_tokens ?? 0;
    t.cacheWrite += u?.cache_creation_input_tokens ?? 0;
    t.output += u?.output_tokens ?? 0;
  }
  return t;
}

/** Input tokens of a run: fresh, cache-read and cache-write, all turns. */
export const inputTokens = (t) => (t ? t.input + t.cacheRead + t.cacheWrite : null);

/** The result message's usage should already cover every turn; if it reports less than the turns add up to, the larger count wins. */
export function largerUsage(a, b) {
  return inputTokens(b) > inputTokens(a) ? b : a;
}

/**
 * One run with the Skill tool (one turn by default). A PreToolUse hook records every Skill call and denies it, so no skill text loads.
 * `opts.note` adds a UserPromptSubmit note; `opts.skills`, `opts.env`, `opts.settings`, `opts.settingSources` and `opts.append`
 * shape the run. `opts.maxTurns`, `opts.mcpServers` and `opts.allowedTools` let a run use more turns and a search tool. `called` is the
 * FIRST Skill call; calls to other tools before it do not change that. Tokens are counted over every turn. Returns
 * { called, calls, cost, tokens, subtype, init, error, ms, fired } and never the prompt.
 */
export async function runSkillCall(query, opts) {
  const rec = { called: null, calls: 0, cost: 0, fired: 0, init: null, subtype: null, ms: 0 };
  const turns = new Map(); // assistant message id -> usage; one entry per turn, since a message repeats its usage on every block
  const t0 = performance.now();
  const hooks = {
    PreToolUse: [{ matcher: 'Skill', hooks: [async (input) => {
      if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Skill') {
        rec.calls++;
        if (rec.called === null) rec.called = String(input.tool_input?.skill ?? '');
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Recorded by an eval; the skill is not loaded.' } };
    }] }],
    ...(opts.note ? { UserPromptSubmit: [{ hooks: [async (input) => {
      if (input.hook_event_name !== 'UserPromptSubmit') return { continue: true };
      rec.fired++;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: opts.note } };
    }] }] } : {}),
  };
  try {
    const q = query({
      prompt: opts.prompt,
      options: {
        model: opts.model, maxTurns: opts.maxTurns ?? 1, cwd: opts.cwd, settingSources: opts.settingSources ?? ['user'], strictMcpConfig: true, persistSession: false,
        tools: ['Skill'], ...(opts.skills ? { skills: opts.skills } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}), ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.append },
        // Hooks from the user's settings are off: they add text that changes from call to call (it breaks the prompt cache).
        // The hooks passed here still run.
        settings: { disableSkillShellExecution: true, disableAllHooks: true, ...(opts.settings ?? {}) },
        hooks, env: opts.env ?? { ...process.env },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') rec.init = { tools: Array.isArray(m.tools) ? m.tools.length : null, toolNames: Array.isArray(m.tools) ? m.tools.slice(0, 6) : null, skills: Array.isArray(m.skills) ? m.skills.length : null };
      if (m.type === 'assistant' && m.message?.usage) turns.set(m.message.id ?? `t${turns.size}`, m.message.usage);
      if (m.type === 'assistant' && rec.called === null) {
        for (const b of m.message?.content ?? []) if (b?.type === 'tool_use' && b.name === 'Skill' && rec.called === null) rec.called = String(b.input?.skill ?? '');
      }
      if (m.type === 'result') {
        rec.cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
        rec.subtype = m.subtype ?? null;
        rec.tokens = { input: m.usage?.input_tokens ?? 0, cacheRead: m.usage?.cache_read_input_tokens ?? 0, cacheWrite: m.usage?.cache_creation_input_tokens ?? 0, output: m.usage?.output_tokens ?? 0 };
      }
    }
    if (rec.tokens) rec.tokens = largerUsage(rec.tokens, sumUsage([...turns.values()]));
  } catch (e) {
    // The turn limit ends the stream with an error after the result: expected, not a failure.
    if (rec.subtype === null) rec.error = String(e?.code ?? e?.name ?? 'error');
  }
  rec.ms = Math.round(performance.now() - t0);
  return rec;
}
