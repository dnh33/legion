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

/**
 * One turn with only the Skill tool. A PreToolUse hook records every Skill call and denies it, so no skill text loads.
 * `opts.note` adds a UserPromptSubmit note; `opts.skills`, `opts.env`, `opts.settings`, `opts.settingSources` and `opts.append`
 * shape the run. Returns { called, calls, cost, tokens, subtype, init, error, ms, fired } and never the prompt.
 */
export async function runSkillCall(query, opts) {
  const rec = { called: null, calls: 0, cost: 0, fired: 0, init: null, subtype: null, ms: 0 };
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
        model: opts.model, maxTurns: 1, cwd: opts.cwd, settingSources: opts.settingSources ?? ['user'], strictMcpConfig: true, persistSession: false,
        tools: ['Skill'], ...(opts.skills ? { skills: opts.skills } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.append },
        // Hooks from the user's settings are off: they add text that changes from call to call (it breaks the prompt cache).
        // The hooks passed here still run.
        settings: { disableSkillShellExecution: true, disableAllHooks: true, ...(opts.settings ?? {}) },
        hooks, env: opts.env ?? { ...process.env },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') rec.init = { tools: Array.isArray(m.tools) ? m.tools.length : null, toolNames: Array.isArray(m.tools) ? m.tools.slice(0, 6) : null, skills: Array.isArray(m.skills) ? m.skills.length : null };
      if (m.type === 'assistant' && rec.called === null) {
        for (const b of m.message?.content ?? []) if (b?.type === 'tool_use' && b.name === 'Skill' && rec.called === null) rec.called = String(b.input?.skill ?? '');
      }
      if (m.type === 'result') {
        rec.cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0;
        rec.subtype = m.subtype ?? null;
        rec.tokens = { input: m.usage?.input_tokens ?? 0, cacheRead: m.usage?.cache_read_input_tokens ?? 0, cacheWrite: m.usage?.cache_creation_input_tokens ?? 0, output: m.usage?.output_tokens ?? 0 };
      }
    }
  } catch (e) {
    // The turn limit ends the stream with an error after the result: expected, not a failure.
    if (rec.subtype === null) rec.error = String(e?.code ?? e?.name ?? 'error');
  }
  rec.ms = Math.round(performance.now() - t0);
  return rec;
}
