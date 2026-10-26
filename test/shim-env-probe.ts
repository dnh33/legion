/**
 * Test-only preload for the run-tools shim (node --import): once the shim has started it prints whether LEGION_RUN_TOKEN is still in
 * its environment, so test/acp-tools-route.test.ts can check the shim removed it.
 */
setTimeout(() => {
  process.stderr.write(`[env-probe] LEGION_RUN_TOKEN is ${process.env.LEGION_RUN_TOKEN === undefined ? 'absent' : 'present'}\n`);
}, 800).unref();
export {};
