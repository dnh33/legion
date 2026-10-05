/** Auto model routing + escalation. */
import type { ConcreteModel, ModelChoice } from '../shared/types.ts';

export interface RouteDecision { model: ConcreteModel; reason: string; prompt: string }

// "architecture" is covered by the prefix "architect" (counting both would make one word score twice).
const HARD_KEYWORDS = [
  'architect', 'design a', 'refactor', 'debug', 'root cause', 'prove', 'proof', 'optimi', 'security', 'audit',
  'migrate', 'migration', 'plan', 'strategy', 'complex', 'tricky', 'concurrency', 'race condition', 'algorithm',
  'trade-off', 'tradeoff', 'review',
];
const EXPLICIT_PHRASES = ['think hard', 'ultrathink', 'be thorough', 'deep dive'];
const LONG_PROMPT_CHARS = 1800;
const PREFIX_RE = /^\s*\/(opus|sonnet)(?=\s|$)\s*/i;
const MODEL_PREFIX_RE = /^\s*\/model\s+([A-Za-z0-9._:\[\]-]+)(?=\s|$)\s*/i;
const NO_ESCALATE_RE = /auth|login|credit|billing|rate.?limit|429|401|403|overloaded/i;
const ESCALATE_SUBTYPES = new Set(['error_max_turns', 'error_during_execution']);

export function routeModel(prompt: string, choice: ModelChoice, ctx?: { priorModel?: ConcreteModel }): RouteDecision {
  // "/model <value>" forces any model; "/model auto" just means "let the router decide" for this message.
  const mm = MODEL_PREFIX_RE.exec(prompt);
  if (mm) {
    const value = mm[1]!;
    const rest = prompt.slice(mm[0].length);
    if (value.toLowerCase() === 'auto') return routeModel(rest, 'auto', ctx);
    return { model: value, reason: `prefix /model ${value}`, prompt: rest };
  }
  const m = PREFIX_RE.exec(prompt);
  if (m) {
    const model = m[1]!.toLowerCase() as ConcreteModel;
    return { model, reason: `prefix /${model}`, prompt: prompt.slice(m[0].length) };
  }
  if (choice !== 'auto' && choice) return { model: choice, reason: `chosen: ${choice}`, prompt }; // any alias / catalog id passes through

  if (ctx?.priorModel === 'opus') return { model: 'opus', reason: 'continuing on opus', prompt };

  const lower = prompt.toLowerCase();
  if (prompt.length > LONG_PROMPT_CHARS) return { model: 'opus', reason: `long prompt (${prompt.length} chars)`, prompt };
  const phrase = EXPLICIT_PHRASES.find((p) => lower.includes(p));
  if (phrase) return { model: 'opus', reason: `explicit phrase "${phrase}"`, prompt };
  const hits = HARD_KEYWORDS.filter((k) => lower.includes(k));
  if (hits.length >= 2) return { model: 'opus', reason: `hard keywords: ${hits.join(', ')}`, prompt };
  return { model: 'sonnet', reason: 'default for simple prompt', prompt };
}

export function shouldEscalate(r: { model: ConcreteModel; subtype: string; isError: boolean; errorText?: string }): boolean {
  if (r.model !== 'sonnet') return false;
  if (!ESCALATE_SUBTYPES.has(r.subtype) && !r.isError) return false;
  if (r.errorText && NO_ESCALATE_RE.test(r.errorText)) return false;
  return true;
}
