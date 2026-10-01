export const PRIMITIVES: string[];
export function createVerbs(ctx: Record<string, unknown>, persona: { tempo?: number; verbs?: unknown[] }): {
  verbs: unknown[]; pick(when?: string, now?: number): unknown; play(v: unknown): number; cancel(): void; tempo: number; busy: boolean;
  byId(id: string): unknown; hasHaloStep: boolean;
};
