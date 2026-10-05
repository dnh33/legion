/**
 * What a run probably cost. Claude Code reports tokens per turn, and dollars only for the whole session (plan §2.4), so the mod
 * estimates per agent from a price table. Always shown with "≈".
 *
 * Source: Anthropic, "Pricing", https://platform.claude.com/docs/en/about-claude/pricing (model pricing table and the prompt
 * caching multipliers), fetched 2026-10-05. First-party Claude API rates, global routing, standard speed, no batch discount.
 * Every number below is copied from that table.
 *
 * ASSUMED (not knowable from the token counts): `cacheWrite` is priced at the 5-minute cache-write rate (1.25x input). Claude
 * Code's cache TTL per request is not reported in TokenCount; the 1-hour rate is 2x input, so a run on 1-hour writes is
 * under-estimated on that part.
 * ASSUMED: a bare alias (`opus`, `sonnet`, `haiku`, `fable`) means the current generation of that family (Opus 5.5, Sonnet 5.5,
 * Haiku 4.5, Fable 5.1). Claude Code resolves aliases itself; turn.complete usage carries the full id the API reports, which is
 * priced exactly.
 * Not covered: fast mode, `inference_geo: "us"` (1.1x), Bedrock / Vertex pricing.
 */
import type { TokenCount } from '../../types/index.d.ts'

/** The date the table was read from the pricing page. Shown in `/legion doctor`. */
export const PRICES_AS_OF = '2026-10-05'
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'

export type Family = 'opus' | 'sonnet' | 'haiku' | 'fable'
/** USD per million tokens. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

const p = (input: number, output: number, cacheRead: number, cacheWrite: number): Price => ({ input, output, cacheRead, cacheWrite })

/**
 * Per model version, as the pricing page lists them. Key: `<family>-<major>[-<minor>]`. cacheWrite is the 5-minute write rate.
 * Mythos 5 / 5.1 are priced as Fable 5 / 5.1 (the page lists them equal).
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'fable-5-1': p(10, 50, 0.25, 12.5),
  'fable-5': p(10, 50, 1, 12.5),
  'opus-5-5': p(4, 20, 0.2, 5),
  'opus-5': p(5, 25, 0.5, 6.25),
  'opus-4-8': p(5, 25, 0.5, 6.25),
  'opus-4-7': p(5, 25, 0.5, 6.25),
  'opus-4-6': p(5, 25, 0.5, 6.25),
  'opus-4-5': p(5, 25, 0.5, 6.25),
  'opus-4-1': p(15, 75, 1.5, 18.75),
  'opus-4': p(15, 75, 1.5, 18.75),
  'sonnet-5-5': p(2, 10, 0.2, 2.5),
  'sonnet-5': p(2, 10, 0.2, 2.5),
  'sonnet-4-6': p(3, 15, 0.3, 3.75),
  'sonnet-4-5': p(3, 15, 0.3, 3.75),
  'sonnet-4': p(3, 15, 0.3, 3.75),
  'haiku-4-5': p(1, 5, 0.1, 1.25),
  'haiku-3-5': p(0.8, 4, 0.08, 1),
}

/** The current generation of each family: what a bare alias, or an id whose version is not in the table, is priced as. */
export const CURRENT: Readonly<Record<Family, string>> = { fable: 'fable-5-1', opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-4-5' }

/** The family of an alias or a model id (`opus`, `claude-opus-5-5`, `anthropic.claude-sonnet-5`, `claude-mythos-5-1`), if any. */
export function familyOf(model: string | undefined): Family | undefined {
  const m = (model ?? '').toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return undefined
}

/**
 * The table key for a model id: `claude-opus-4-8-20260101` → `opus-4-8`. `none` when the id names no version (a bare alias),
 * `unknown` when it names a version the table does not have (a newer model than the table).
 */
function versionKey(model: string, family: Family): string | 'none' | 'unknown' {
  const name = family === 'fable' ? '(?:fable|mythos)' : family
  const m = new RegExp(`${name}-(\\d+)(?:[-.](\\d)(?!\\d))?`).exec(model.toLowerCase())
  if (!m) return 'none'
  const withMinor = m[2] !== undefined ? `${family}-${m[1]}-${m[2]}` : undefined
  if (withMinor && PRICES[withMinor]) return withMinor
  const major = `${family}-${m[1]}`
  return PRICES[major] ? major : 'unknown'
}

export type PriceLookup = { price: Price; key: string; isEstimateUncertain: boolean }

/**
 * The price for a model. A bare alias is priced as the family's current generation. A model the table cannot place is priced as
 * the current Sonnet, and a family member of a version the table does not list as that family's current generation; both are
 * flagged uncertain.
 */
export function priceFor(model: string | undefined): PriceLookup {
  const family = familyOf(model)
  if (!family) return { price: PRICES[CURRENT.sonnet]!, key: CURRENT.sonnet, isEstimateUncertain: true }
  const v = versionKey(model!, family)
  const key = v === 'none' || v === 'unknown' ? CURRENT[family] : v
  return { price: PRICES[key]!, key, isEstimateUncertain: v === 'unknown' }
}

export type CostEstimate = { usd: number; key: string; isEstimateUncertain: boolean }

/** The estimated cost in USD of these token counts on this model. */
export function estimateUsd(model: string | undefined, tokens: TokenCount): CostEstimate {
  const { price, key, isEstimateUncertain } = priceFor(model)
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0)
  const usd = (n(tokens.input) * price.input + n(tokens.output) * price.output + n(tokens.cacheRead) * price.cacheRead + n(tokens.cacheWrite) * price.cacheWrite) / 1_000_000
  return { usd, key, isEstimateUncertain }
}

/** The engine's usage shape (claude-code.d.ts ModelUsage, :5884) as the mod's TokenCount. */
export function tokensFromUsage(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): TokenCount {
  return { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 }
}

export const ZERO_TOKENS: TokenCount = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}
