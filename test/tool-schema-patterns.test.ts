// The API checks every tool's input_schema; a `pattern` with an unescaped "[" inside a character class is rejected there
// ("JSON schema is invalid"), which fails the whole run. JavaScript accepts it, so only a check like this one catches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });

const BACKSLASH = String.fromCharCode(92);

/** True when a "[" appears unescaped inside a character class of the regex source. */
const nestedBracket = (src: string): boolean => {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === BACKSLASH) { i++; continue; }
    if (!inClass && c === '[') { inClass = true; if (src[i + 1] === ']') i++; continue; }
    if (inClass && c === '[') return true;
    if (inClass && c === ']') inClass = false;
  }
  return false;
};

test('the helper spots the bad shape and passes the escaped one', () => {
  assert.equal(nestedBracket(String.raw`^[A-Za-z0-9._:/[\]-]+$`), true);
  assert.equal(nestedBracket(String.raw`^[A-Za-z0-9._:/\[\]-]+$`), false);
});

/** The source of each regex literal passed to `.regex(`: read up to the closing "/" outside a class ("/" is legal inside one). */
const regexLiterals = (text: string): string[] => {
  const out: string[] = [];
  for (let at = text.indexOf('.regex(/'); at !== -1; at = text.indexOf('.regex(/', at + 1)) {
    let i = at + '.regex(/'.length, inClass = false, src = '';
    for (; i < text.length && text[i] !== '\n'; i++) {
      const c = text[i]!;
      if (c === BACKSLASH) { src += c + (text[i + 1] ?? ''); i++; continue; }
      if (c === '[') inClass = true; else if (c === ']') inClass = false; else if (c === '/' && !inClass) break;
      src += c;
    }
    out.push(src);
  }
  return out;
};

test('the literal reader keeps a "/" that sits inside a class', () => {
  assert.deepEqual(regexLiterals(String.raw`z.string().regex(/^[a/b]+$/)`), [String.raw`^[a/b]+$`]);
});

test('no zod .regex() in src has an unescaped "[" inside a character class', () => {
  const bad: string[] = [];
  for (const f of files('src')) for (const src of regexLiterals(readFileSync(f, 'utf8'))) if (nestedBracket(src)) bad.push(`${f}: /${src}/`);
  assert.deepEqual(bad, []);
});
