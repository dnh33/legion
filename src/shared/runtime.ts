/**
 * Which runtime a model value runs on. The model string stays the one source of truth:
 *   `sonnet`, `auto`, an AWS `arn:` id          Claude (Claude Code)
 *   `<provider>:<model>`                        a model provider (`openrouter:vendor/model`)
 *   `acp:<entry>` or `acp:<entry>/<model>`      an agent host (Hermes is the first), reached over the Agent Client Protocol
 *
 * This file holds the only shape check of the `<id>:` prefix. Everything that has to treat the three differently (tools text,
 * compaction, log labels, the run itself) asks runtimeOf() here, so a new runtime cannot be mistaken for Claude or a provider.
 */

export type Runtime = 'claude' | 'provider' | 'acp';

/** The id every agent host model value starts with. It is also a reserved provider id. */
export const ACP_PREFIX = 'acp';

const PREFIX_RE = /^([a-z][a-z0-9-]{1,31}):(.+)$/;
export const ENTRY_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** A `<id>:<rest>` model value split in two, or undefined for anything else. A Bedrock ARN (`arn:`) is a Claude id, not a prefix. */
export function splitPrefixed(model: string | undefined): { prefix: string; rest: string } | undefined {
  const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
  return m && m[1] !== 'arn' ? { prefix: m[1]!, rest: m[2]! } : undefined;
}

export function runtimeOf(model: string | undefined): Runtime {
  const p = splitPrefixed(model);
  return !p ? 'claude' : p.prefix === ACP_PREFIX ? 'acp' : 'provider';
}

/** The provider id of a provider model value (`openrouter` for `openrouter:x`), or undefined for Claude and agent host values. */
export function providerIdOf(model: string | undefined): string | undefined {
  return runtimeOf(model) === 'provider' ? splitPrefixed(model)!.prefix : undefined;
}

/** `acp:hermes` -> `{entryId:'hermes'}`; `acp:hermes/anthropic:claude-x` -> `{entryId:'hermes', modelId:'anthropic:claude-x'}`. Undefined for any other value. */
export function parseAcpModel(model: string): { entryId: string; modelId?: string } | undefined {
  if (runtimeOf(model) !== 'acp') return undefined;
  const rest = splitPrefixed(model)!.rest;
  const slash = rest.indexOf('/');
  const entryId = slash < 0 ? rest : rest.slice(0, slash);
  if (!ENTRY_ID_RE.test(entryId)) return undefined;
  const modelId = slash < 0 ? '' : rest.slice(slash + 1);
  return modelId ? { entryId, modelId } : { entryId };
}

/**
 * The words that name an agent host run in logs and usage: the entry's name. Until entries carry their own label this is the
 * entry id with a capital (`hermes` -> `Hermes`). Undefined when the model is not an agent host value.
 */
export function acpLabel(model: string | undefined): string | undefined {
  const entryId = model === undefined ? undefined : parseAcpModel(model)?.entryId;
  return entryId ? entryId[0]!.toUpperCase() + entryId.slice(1) : undefined;
}
