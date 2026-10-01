// "Is the idle mascot still alive?": pixel change of the idle stage over 1 s steps (CSS bob/sway/halo + blinks), as shipped.
//   node idle-alive.mjs <base|new>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { startEnv, openPage } from './env.mjs';
const which = process.argv[2] || 'new';
const env = await startEnv({ ui: which === 'base' ? '/tmp/m/u-base/dist-ui' : '/tmp/m/wt-u/dist-ui', repo: '/tmp/m/wt-u', port: 48400 });
const { browser, page } = await openPage(env);
const dir = `/tmp/m/u-shots/alive-${which}`; fs.mkdirSync(dir, { recursive: true });
const el = page.locator('.mascot-stage .mx');
for (let i = 0; i < 8; i++) { await el.screenshot({ path: `${dir}/f${i}.png` }); await page.waitForTimeout(1000); }
await browser.close(); await env.stop();
console.log(execFileSync('python3', ['-c', `
from PIL import Image, ImageChops
import sys
fr=[Image.open('${dir}/f%d.png'%i).convert('RGB') for i in range(8)]
out=[]
for i in range(7):
    d=ImageChops.difference(fr[i],fr[i+1]).convert('L').point(lambda v:255 if v>12 else 0)
    out.append(sum(1 for p in d.getdata() if p))
print('changed px between 1 s frames:',out)
`], { encoding: 'utf8' }));
process.exit(0);
