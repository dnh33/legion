/** Mutants M01-M29 of the spend path (the harness and the list: test/bsv-spend-mutants-lib.ts). */
import { registerMutants } from './bsv-spend-mutants-lib.js';

registerMutants((n) => n < 30, 'M01-M29');
