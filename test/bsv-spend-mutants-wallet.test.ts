/** Mutants M30 and up: a wallet that asks its owner while it builds (the harness and the list: test/bsv-spend-mutants-lib.ts). */
import { registerMutants } from './bsv-spend-mutants-lib.js';

registerMutants((n) => n >= 30, 'M30 and up');
