// Builds docs/demo/muster-lab/index.html: the Legion Muster Lab, one self-contained file (no network).
// Inlines the real engine (ui/src/mascot/engine.js + verbs.js, verbatim apart from the module syntax),
// mascot.css, the 13 bust jsons + personas, and the 13 portraits as data: URIs.
// usage: node docs/demo/muster-lab/build.mjs      (from the repo root or anywhere)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const M = path.join(repo, 'ui/src/mascot');
const read = (f) => fs.readFileSync(f, 'utf8');
const ORDER = ['zealot','builder','scout','inquisitor','scribe','archivist','sentinel','forgemaster','exorcist','preceptor','herald','assayer','sculptor'];

const verbs = read(path.join(M, 'verbs.js')).replace(/^export /gm, '');
const eng = read(path.join(M, 'engine.js')).replace(/^import .*$/m, '').replace(/^export /gm, '');
const engine = `const __verbs = (() => {\n${verbs}\nreturn { createVerbs, PRIMITIVES };\n})();\nconst createVerbs = __verbs.createVerbs;\nconst Engine = (() => {\n${eng}\nreturn { createMascot, STATES, runtimeStats };\n})();`;
const css = read(path.join(M, 'mascot.css')) + '\n.mx { max-width: none; }\n.host > .mx { width: 100%; }\n';

const safe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
const bots = {};
for (const id of ORDER) {
  const data = JSON.parse(read(path.join(M, 'data', (id === 'zealot' ? 'relic' : id) + '.json')));
  const persona = JSON.parse(read(path.join(M, 'personas', id + '.json')));
  bots[id] = { data, persona };
}

// Zealot's portrait source has unescaped "<" (25) and "&" characters inside <text>/<tspan> glyph runs (not well-formed XML), which makes a browser
// refuse it as an image. The lab embeds a copy with those characters escaped; the source file is untouched.
const portraitSrc = (id) => id === 'zealot' ? path.join(repo, 'docs/art/muster/zealot/zealot.svg') : path.join(repo, 'docs/art/muster', id, id + '.portrait.svg');
const portraits = {};
for (const id of ORDER) {
  let svg = read(portraitSrc(id));
  if (id === 'zealot') svg = svg.replace(/<(?=<\/(?:text|tspan)>)/g, '&lt;').replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
  portraits[id] = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const out = read(path.join(here, 'template.html'))
  .replace('/*__ENGINE__*/', () => safe(engine))
  .replace('/*__CSS__*/', () => css)
  .replace('/*__DATA__*/', () => safe(JSON.stringify(bots)))
  .replace('/*__PORTRAITS__*/', () => JSON.stringify(portraits));
fs.writeFileSync(path.join(here, 'index.html'), out);
console.log('wrote', path.join(here, 'index.html'), (out.length / 1e6).toFixed(2) + ' MB');
