/**
 * Side-effect import: puts the compromised-CA key block (tls-blocklist.ts) on node:tls. The core entry imports this second, right
 * after the log redactor, so the block is in place before any other module is evaluated (test/tls-blocklist.test.ts).
 */
import tls from 'node:tls';
import { installTlsBlocklist } from './tls-blocklist.js';

installTlsBlocklist(tls);
