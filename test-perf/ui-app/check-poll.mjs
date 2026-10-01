// ComputerCard screenshot poll runs only while the Ops panel is open.   node check-poll.mjs <base|new>   (base is expected to fail)
import assert from 'node:assert/strict';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 49300 });
const { browser, page, errs } = await openPage(env);
const shots = async () => (await env.stat()).apiCalls['/api/vms/zealot/screenshot'] || 0;
await env.emit({ type: 'vm.updated', vm: { agentId: 'zealot', sandboxId: 's', state: 'running', size: 'default', lastUsedAt: new Date().toISOString(), createdAt: new Date().toISOString() } });
await page.waitForTimeout(6000);
const open = await shots(); console.log('screenshot polls with Ops open (6 s):', open);
await page.keyboard.press('Control+.'); await page.waitForTimeout(800);
const c0 = await shots(); await page.waitForTimeout(7000); const closed = (await shots()) - c0;
console.log('screenshot polls with Ops closed (7 s):', closed, errs);
await browser.close(); await env.stop();
try { assert.ok(open >= 2, 'polls while open'); assert.equal(closed, 0, 'no polls while closed'); console.log('ok'); process.exit(0); } catch (e) { console.log('FAIL', e.message); process.exit(1); }
