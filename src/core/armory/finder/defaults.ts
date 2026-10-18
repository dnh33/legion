/**
 * Tuning values for the skill finder, set by the Task 11 eval (scripts/skill-finder-eval.mjs) on the owner's own sets, over the skills that
 * are switched on. The rule: the most recall@3 with a false-note rate of at most 0.15 on real no-skill prompts and a note precision of at
 * least 0.50. The keyword ranker has no point that meets both bars (see THRESHOLDS); the local ranker meets them only where a note is rare.
 */

/**
 * The short skill list (settings.slimListing, default false; 'auto' keeps the full list until an agent has more than WARN_ABOVE skills) was measured once, on one 104-skill catalog: 36 percent fewer input tokens per call with no
 * real loss of correct skill calls. A smaller catalog gains little and loses description detail, and that case was not measured, so 'auto' waits for the
 * Settings warning threshold (SKILL_WARN_ABOVE, 40).
 */

/** Weight of each field in the BM25F score. The id's parts count as part of `name`. */
export const FIELD_WEIGHTS = { name: 3, description: 1.5, whenToUse: 1.5, headings: 0.5 } as const;

/** BM25 term-frequency saturation. */
export const K1 = 1.2;
/** BM25 length normalisation: 0 is none, 1 is full. */
export const B = 0.75;

/**
 * Score floors for the note when keywords ranked the skills (BM25F; the scale follows the size of the catalog). A hit under its floor adds no note.
 * No floor makes the keyword note precise enough (no point meets both bars), so these are the floors with the most recall at a false-note rate
 * of at most 0.15 (balanced), about half of it (strict) and about double (eager). The note is then wrong more often than right: suggestions are off by default (see FINDER_DEFAULTS.suggest).
 */
export const THRESHOLDS = { strict: 40, balanced: 20, eager: 15 } as const;

/** Time limits in milliseconds. Past the limit, the finder adds no note. */
export const DEADLINE_MS = 50;
export const RERANK_DEADLINE_MS = 2500;
/** How long the engine waits for a turn's note before it goes on without one. */
export const TURN_TIMEOUT_MS = DEADLINE_MS * 4;
export const RERANK_TURN_TIMEOUT_MS = 3300;
/** Shown next to the rerank setting (Task 12). */
export const RERANK_LATENCY_NOTE = 'Adds up to about 2.5 seconds before each reply while it ranks close calls.';

/** How many skills the note lists, unless you set another k. */
export const DEFAULT_K = 3;

/**
 * Embeddings, tuned in Task 11.
 * The fused score is `w * cosineNorm + (1 - w) * bm25Norm`, both 0..1 over the candidates.
 */
// The weight, the fused floors and the cosine floor below are tuned for the local model only. The provider embedder is untuned: it gets no
// cosine floor and the search weight.
export const FUSION_WEIGHT = 0.8;
/**
 * The weight for the search tool (armory_find), which has no floor and so needs the best order with no cut: the weight with the most mean
 * recall@3 over Set A and Set B with no cut (agent pool, task 11: 0.335 at 0.4 against 0.261 at the note weight).
 */
export const SEARCH_FUSION_WEIGHT = 0.4;
/** Score floors for the note when embeddings ranked the skills (the fused score, 0..1). */
export const FUSED_THRESHOLDS = { strict: 1.05, balanced: 0.95, eager: 0.9 } as const;
/**
 * A narrow spread is not stretched to 0..1. Without this the best candidate would always score 1, even when
 * nothing fits the message, and the floor would never say no. Cosines of the e5 model sit close together, so the spread is small.
 */
export const COSINE_MIN_SPREAD = 0.05;
/** The same for keywords: a best keyword score under this does not count as a full match. Its own value: it does not move with the keyword floors. */
export const BM25_MIN_SPREAD = 2;
/**
 * A skill whose raw cosine to the message is under this gets no note, whatever its fused score. The fused score is min-max over the
 * candidates, so the best skill always scores high; the e5 cosines of unrelated text still sit in a band, and this floor is the only
 * absolute test of fit. A skill with no vector yet is not judged by it.
 */
export const RAW_COSINE_FLOOR = 0.88;
/** How long the finder waits for the message's embedding before it uses keywords for that turn. */
export const EMBED_QUERY_BUDGET_MS = 300;
/** How long the engine waits for a turn's note when embeddings are on. */
export const EMBED_TURN_TIMEOUT_MS = 500;
/** The local model's helper process stops after this long without a request. */
export const MODEL_IDLE_MS = 5 * 60_000;
/** After the local model's helper fails to load (not a failed integrity check), no new helper starts for this long. */
export const MODEL_LOAD_BACKOFF_MS = 5 * 60_000;
/** After a provider embedding call fails or answers wrongly, no call goes to that provider and model for this long. */
export const PROVIDER_EMBED_BACKOFF_MS = 10 * 60_000;

/**
 * The Haiku rerank. The margin is from the Task 11 sample (the largest margin set that did not hurt precision or the false-note rate on either
 * ranker; the gain is small and the samples are small). It runs only when the top three scores are within RERANK_MARGIN of each other
 * (on the normalised scale, 0..1). It sees the top RERANK_CANDIDATES skills, the message cut to RERANK_TEXT_CHARS and each
 * description cut to RERANK_DESC_CHARS.
 */
export const RERANK_MARGIN = 0.2;
export const RERANK_CANDIDATES = 8;
export const RERANK_TEXT_CHARS = 2000;
export const RERANK_DESC_CHARS = 200;
/** A request that missed its deadline is abandoned, but the session stays busy until its result comes. It is closed at this ceiling. */
export const RERANK_HARD_MS = 30_000;
/** Estimated cost of one request, reserved in the month's spend before the request and replaced by the real cost. US dollars. */
export const RERANK_RESERVE_USD = 0.002;
/** The warm session is closed and restarted after this many reranks, or after this long without one. */
export const RERANK_RECYCLE_AFTER = 10;
export const RERANK_IDLE_MS = 10 * 60_000;
/** After this many failures in a row (an error or an invalid answer; a timeout does not count) no session is started for RERANK_BACKOFF_MS. */
export const RERANK_FAILS_BEFORE_BACKOFF = 3;
export const RERANK_BACKOFF_MS = 60_000;
/** How long a fresh session may take to answer its warm-up message. */
export const RERANK_WARM_MS = 20_000;
