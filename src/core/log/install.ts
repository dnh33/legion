/**
 * Side-effect module: installs the stream wrappers when it is imported. src/bin/legion-core.ts imports it FIRST, before any
 * other module, so nothing the core loads can write to stdout or stderr unredacted (test/log-wiring.test.ts checks the
 * import order). Importing it twice is harmless: a stream is wrapped once.
 */
import { installStreamWrappers } from './stream-wrap.js';

installStreamWrappers();
