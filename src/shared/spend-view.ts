/** What GET /api/spend returns (the app's Spending view reads it too). */
export interface SpendSummary {
  /** This ISO week. */
  week: number;
  today: number;
  /** Within this week, biggest first. A run with no project is listed with `projectId: null`. */
  byProject: Array<{ projectId: string | null; usd: number }>;
  byAgent: Array<{ agentId: string; usd: number }>;
  /** The last 14 local days, oldest first, zero-filled. */
  daily: Array<{ day: string; usd: number }>;
}
