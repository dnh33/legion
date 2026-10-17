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
export const RERANK_DEADLINE_MS = 2000;

/** How many skills the note lists, unless you set another k. */
export const DEFAULT_K = 3;
