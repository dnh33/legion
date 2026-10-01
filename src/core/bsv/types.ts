/** Types of the BSV mode v0 module (knowledge and visibility only). */

export type BsvNetwork = 'testnet';

export type BsvSeedStatus = 'loaded' | 'already-loaded' | 'no-kg' | 'error';

export interface BsvSeedResult {
  status: BsvSeedStatus;
  /** Visible bsv nodes after the call (loaded and already-loaded). */
  nodes?: number;
  created?: number;
  updated?: number;
  edges?: number;
  error?: string;
}

/** GET /api/bsv */
export interface BsvStatus {
  enabled: boolean;
  network: BsvNetwork;
  /** The Assayer exists in the store (it is only listed while enabled). */
  assayerAvailable: boolean;
  /** At least one bsv-scope node is visible in the knowledge graph (always false while off: the scope is hidden). */
  knowledgeLoaded: boolean;
  /** Number of visible bsv-scope nodes (0 while off). */
  knowledgeNodes: number;
}

/** POST /api/bsv response: the status plus what the knowledge-pack load did (only when switching or staying on). */
export interface BsvToggleResult extends BsvStatus {
  seed?: BsvSeedResult;
}
