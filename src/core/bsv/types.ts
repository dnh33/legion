/** Types of the BSV mode v0 module (knowledge and visibility only). */

export type BsvNetwork = 'testnet';

export type BsvSeedStatus = 'loaded' | 'upgraded' | 'repaired' | 'already-loaded' | 'no-kg' | 'error';

export interface BsvSeedResult {
  status: BsvSeedStatus;
  /** Nodes in the bundled pack (loaded, upgraded and already-loaded). */
  nodes?: number;
  created?: number;
  updated?: number;
  edges?: number;
  /** Pack version that was loaded before (0 = none) and the bundled one. */
  from?: number;
  to?: number;
  /** Nodes that were not there (same as created). */
  added?: number;
  /** Nodes a human edited: the pack text for them was not applied. Present after a load or an upgrade. */
  skippedEdited?: string[];
  /** Pack nodes a human deleted: they stay deleted until restored with POST /api/kg/seed/bsv {restore:[ids]}. */
  skippedRemoved?: string[];
  /** Nodes brought back by a restore. */
  restored?: string[];
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
