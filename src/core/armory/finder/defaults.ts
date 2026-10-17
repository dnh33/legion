/** Tuning values for the skill finder. Provisional: Task 11 tunes the thresholds against the eval set. */

/** Weight of each field in the BM25F score. The id's parts count as part of `name`. */
export const FIELD_WEIGHTS = { name: 3, description: 1.5, whenToUse: 1.5, headings: 0.5 } as const;

/** BM25 term-frequency saturation. */
export const K1 = 1.2;
/** BM25 length normalisation: 0 is none, 1 is full. */
export const B = 0.75;

/** Score floors for the note. A hit under its floor adds no note. */
export const THRESHOLDS = { strict: 4, balanced: 2, eager: 0.8 } as const;

/** Time limits in milliseconds. Past the limit, the finder adds no note. */
export const DEADLINE_MS = 50;
export const RERANK_DEADLINE_MS = 2500;
/** How long the engine waits for a turn's note before it goes on without one. */
export const TURN_TIMEOUT_MS = DEADLINE_MS * 4;
export const RERANK_TURN_TIMEOUT_MS = 3000;
/** Shown next to the rerank setting (Task 12). */
export const RERANK_LATENCY_NOTE = 'Adds up to about 2 seconds before each reply while it ranks close calls.';

/** How many skills the note lists, unless you set another k. */
export const DEFAULT_K = 3;

/**
 * Embeddings. Provisional, tuned in Task 11.
 * The fused score is `w * cosineNorm + (1 - w) * bm25Norm`, both 0..1 over the candidates.
 */
export const FUSION_WEIGHT = 0.6;
/** Score floors for the note when embeddings ranked the skills (the fused score, 0..1). */
export const FUSED_THRESHOLDS = { strict: 0.75, balanced: 0.6, eager: 0.45 } as const;
/**
 * A narrow spread is not stretched to 0..1. Without this the best candidate would always score 1, even when
 * nothing fits the message, and the floor would never say no. Cosines of the e5 model sit close together, so the spread is small.
 */
export const COSINE_MIN_SPREAD = 0.05;
/** The same for keywords: a best score under the balanced floor does not count as a full match. */
export const BM25_MIN_SPREAD = THRESHOLDS.balanced;
/** How long the finder waits for the message's embedding before it uses keywords for that turn. */
export const EMBED_QUERY_BUDGET_MS = 300;
/** How long the engine waits for a turn's note when embeddings are on. */
export const EMBED_TURN_TIMEOUT_MS = 500;
/** The local model's helper process stops after this long without a request. */
export const MODEL_IDLE_MS = 5 * 60_000;

/**
 * The Haiku rerank. Provisional, tuned in Task 11. It runs only when the top three scores are within RERANK_MARGIN of each other
 * (on the normalised scale, 0..1). It sees the top RERANK_CANDIDATES skills, the message cut to RERANK_TEXT_CHARS and each
 * description cut to RERANK_DESC_CHARS.
 */
export const RERANK_MARGIN = 0.15;
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
/** After this many failures in a row (a timeout counts) no session is started for RERANK_BACKOFF_MS. */
export const RERANK_FAILS_BEFORE_BACKOFF = 3;
export const RERANK_BACKOFF_MS = 60_000;
/** How long a fresh session may take to answer its warm-up message. */
export const RERANK_WARM_MS = 20_000;
