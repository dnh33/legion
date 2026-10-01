import { startEnv, openPage, busyPct } from './env.mjs';
const which = process.argv[2] || 'base';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48100 });
const { browser, page, cdp, errs } = await openPage(env);
console.log(await busyPct(page, cdp, 5000));
console.log(await env.stat(), errs);
await browser.close(); await env.stop(); process.exit(0);
