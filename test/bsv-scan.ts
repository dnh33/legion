/**
 * The static scan behind the BSV tripwire tests. It reads every source file under src/ and ui/src and reports anything that
 * could start a wallet, chain or outbound-network feature: wallet names and the wallet port, outbound network access,
 * socket modules, child processes, string decoding that can hide a name, and tool registrations whose name is built at run time.
 *
 * What it can and cannot do (stated in docs/BSV-MODE.md): it catches names written in the source, the usual ways of spelling them
 * in pieces ('a' + 'b', ['a','b'].join(''), template parts), aliases of the network globals and computed access to them, and any
 * import (static, dynamic or require) of a network or process module. It cannot stop code that is determined to hide, for example
 * a name assembled from data at run time, an eval, or a shell command run through a tool an agent already has. The allowlist below
 * is the whole list of files that may talk to a network or start a process, each with its reason; a new file that does so fails the
 * build until someone adds it here, on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'fetch' | 'socket-module' | 'inbound-http' | 'child-process' | 'decode';
export type Allow = Record<string, { kinds: Kind[]; reason: string }>;

/** Path (from the repo root, forward slashes) -> what that file may do and why. Anything else fails. */
export const ALLOWLIST: Allow = {
  'src/core/boat.ts': { kinds: ['fetch'], reason: "the boat.dev REST client: the user's own cloud VMs, host taken from config.boat.baseUrl" },
  'src/core/server.ts': { kinds: ['inbound-http'], reason: 'the local HTTP, SSE and MCP API; it listens on 127.0.0.1 only and makes no outbound call' },
  'src/electron/main.ts': { kinds: ['fetch', 'child-process'], reason: 'probes the core it starts on 127.0.0.1 (/health) and spawns that core as a child process' },
  'src/bin/legion-mcp-stdio.ts': { kinds: ['fetch', 'child-process'], reason: 'the stdio MCP proxy: talks only to the local core on 127.0.0.1 and starts that core (node dist/src/bin/legion-core.js) when it is not running' },
  'ui/src/api.ts': { kinds: ['fetch'], reason: "the UI's client of the local core (fetch and EventSource on the core base URL)" },
  'ui/src/rooms/roomsStore.ts': { kinds: ['fetch'], reason: 'downloads a room export from the local core' },
  'src/core/blender/static-check.ts': { kinds: ['decode'], reason: 'the Blender script safety check decodes Python string escapes (\\x41, \\u0041) so it reads literal file paths and attribute names the way Python would' },
  'src/core/blender/tcp.ts': { kinds: ['socket-module'], reason: 'the Blender bridge talks to the add-on socket on 127.0.0.1 only (isLoopbackHost is checked before every connect; the config normalizer refuses any other host)' },
  'src/core/comms/scrub.ts': { kinds: ['decode'], reason: 'the secret detector decodes base64 and rot13 candidates to find seed phrases hidden in them' },
};

const ROOTS = ['src', 'ui/src'];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP = new Set(['node_modules', 'dist']);

export interface ScanResult { files: string[]; toolNames: string[]; violations: string[]; matchedAllow: string[] }

function walk(root: string, rel: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(join(root, rel)); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const r = `${rel}/${n}`;
    if (statSync(join(root, r)).isDirectory()) walk(root, r, out);
    else if (CODE.test(n)) out.push(r);
  }
}

// ------------------------------------------------------------------ a small lexer: comments out, strings blanked or kept

/**
 * Returns the source twice: `kept` has comments removed and strings intact, `code` has comments removed and every string,
 * template text and regex body emptied (template `${...}` parts stay, they are code). Newlines are preserved.
 */
export function lex(src: string): { kept: string; code: string } {
  let kept = '';
  let code = '';
  let i = 0;
  const n = src.length;
  let prev = '';      // last significant character seen in code
  let prevWord = '';  // the identifier that ended at it, if any
  const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '%', '~', '^']);
  const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await']);
  const both = (s: string) => { kept += s; code += s; };

  function template(): void {
    kept += '`'; code += '""'; i++;
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') { kept += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { kept += '`'; i++; return; }
      if (c === '$' && src[i + 1] === '{') { kept += '${'; code += ' '; i += 2; run(true); kept += '}'; code += ' '; continue; }
      kept += c; i++;
    }
  }

  function run(untilBrace: boolean): void {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      const d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') both('\n');
        both(' '); i = stop; continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        kept += src.slice(i, j + 1); code += '""'; i = j + 1; prev = '"'; prevWord = ''; continue;
      }
      if (c === '`') { template(); prev = '"'; prevWord = ''; continue; }
      if (c === '/' && (REGEX_AFTER.has(prev) || REGEX_WORDS.has(prevWord))) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j]!;
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j]!)) j++;
        kept += src.slice(i, j); code += '/rx/'; i = j; prev = '"'; prevWord = ''; continue;
      }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) { i++; return; } depth--; }
      }
      both(c);
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
        // copy the rest of the identifier in one go
        both(src.slice(i + 1, j)); prevWord = src.slice(i, j); prev = src[j - 1]!; i = j; continue;
      }
      if (!/\s/.test(c)) { prev = c; prevWord = ''; }
      i++;
    }
  }
  run(false);
  return { kept, code };
}

/** Joins the ways a name is spelled in pieces, so a token check sees the name: 'a'+'b', 'a'.concat('b'), ['a','b'].join(''), `${'a'}b`. */
export function joinLiterals(src: string): string {
  let s = src;
  for (let pass = 0; pass < 6; pass++) {
    const before = s;
    s = s.replace(/\$\{\s*(['"`])([^'"`\\\n]*)\1\s*\}/g, '$2');
    s = s.replace(/(['"`])\s*\+\s*(['"`])/g, '');
    s = s.replace(/(['"`])\s*\.concat\(\s*(['"`])/g, '');
    s = s.replace(/\[((?:\s*(['"`])[^'"`\\\n]*\2\s*,?)+)\]\s*(\.reverse\(\)\s*)?\.join\(\s*(['"`])([^'"`\\\n]*)\4\s*\)/g, (_m, items: string, _q: string, rev: string | undefined, _q2: string, sep: string) => {
      const parts = [...items.matchAll(/(['"`])([^'"`\\\n]*)\1/g)].map((m) => m[2]!);
      if (rev) parts.reverse();
      return `"${parts.join(sep)}"`;
    });
    if (s === before) break;
  }
  return s;
}

// ------------------------------------------------------------------ the rules

/** Names that no source may contain anywhere (comments included, spelled in pieces included). */
const FORBIDDEN = /(?<![\w.])3321(?!\w)|walletclient|httpwalletjson|@bsv\/sdk|createaction/i;
/** Globals that reach the network; a string literal naming one is a computed-access attempt. */
const NET_GLOBAL_NAME = /['"`](?:fetch|XMLHttpRequest|WebSocket|EventSource)['"`]/;
const COMPUTED_GLOBAL = /\b(?:globalThis|global|window|self)\s*\[|\bReflect\s*\.\s*get\s*\(\s*(?:globalThis|global|window|self)\b/;
const NET_IDENT = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|StreamableHTTPClientTransport|SSEClientTransport|WebSocketClientTransport)\b/;
const SOCKET_MODULE = /^(?:node:)?(?:https|http2|net|tls|dgram|dns|dns\/promises|cluster)$|^(?:undici|axios|node-fetch|cross-fetch|ws|got|superagent|request|socket\.io(?:-client)?)$/;
const HTTP_MODULE = /^(?:node:)?http$/;
const CHILD_MODULE = /^(?:node:)?child_process$/;
const BSV_MODULE = /^@bsv\//;
const DECODE = /\bString\s*\.\s*fromCharCode\b|\bfromCodePoint\b|\batob\b|\bunescape\b/;
const BASE64_DECODE = /Buffer\s*\.\s*from\s*\([^)]*['"`]base64(?:url)?['"`]/;
const TOOL_CALL = /(?:\bregisterTool|\.tool|(?<![\w.$])tool)\s*\(/g;
const TOOL_LITERAL = /^(?:\bregisterTool|\.tool|tool)\s*\(\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)")\s*,/;
/** A tool name is split into words; any of these as a whole word makes it wallet-shaped ("alarm", "design", "payload" are fine). */
const WALLETY = new Set(['wallet', 'bsv', 'spend', 'spending', 'pay', 'payment', 'payments', 'payout', 'sign', 'signing', 'broadcast', 'createaction', 'arm', 'armed', 'freeze', 'mainnet']);
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])$/;

/** Scans `root`/src and `root`/ui/src. `allow` defaults to ALLOWLIST. */
export function scanTree(root: string, allow: Allow = ALLOWLIST): ScanResult {
  const files: string[] = [];
  for (const r of ROOTS) walk(root, r, files);
  const violations: string[] = [];
  const toolNames: string[] = [];
  const matched = new Set<string>();

  for (const f of files) {
    const raw = readFileSync(join(root, f), 'utf8');
    const { kept, code } = lex(raw);
    const joinedRaw = joinLiterals(raw);
    const joinedKept = joinLiterals(kept);
    const allowed = new Set(allow[f]?.kinds ?? []);
    const used = new Map<Kind, string>();
    const bad = (m: string) => violations.push(`${f}: ${m}`);

    // names that never belong anywhere (comments included)
    const tok = FORBIDDEN.exec(joinedRaw);
    if (tok) bad(`contains ${tok[0]}`);

    // network globals: aliases, computed access, names in strings
    const ident = NET_IDENT.exec(code);
    if (ident) used.set('fetch', ident[0]);
    const named = NET_GLOBAL_NAME.exec(joinedKept);
    if (named) bad(`names the network global ${named[0]} in a string (computed access to the network)`);
    if (COMPUTED_GLOBAL.test(joinedKept)) bad('computed access to a global object (globalThis[...]) can reach the network');

    // modules (static, dynamic, require). A specifier that starts with something other than a quote (a bare variable) is refused below.
    // It does NOT see a specifier that starts with a string literal and is finished at run time, e.g. import('node:' + name); it also
    // cannot see globalThis[name] with a name computed from data, or a computed URL passed to fetch inside an allowlisted file
    // (boat.ts, ui/src/api.ts): the allowlist is by file, not by destination. Those are covered by review, not by this scan.
    for (const m of joinedKept.matchAll(/(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*['"`]([^'"`]+)['"`]/g)) {
      const spec = m[1]!;
      if (BSV_MODULE.test(spec)) bad(`imports ${spec}`);
      else if (SOCKET_MODULE.test(spec)) used.set('socket-module', `network module ${spec}`);
      else if (HTTP_MODULE.test(spec)) used.set('inbound-http', `${spec}`);
      else if (CHILD_MODULE.test(spec)) used.set('child-process', `${spec}`);
    }
    if (/\bimport\s*\(\s*[^'"`\s]/.test(kept)) bad('dynamic import with a specifier that is not a string literal');
    if (/\brequire\s*\(\s*[^'"`\s]/.test(kept)) bad('require() with a specifier that is not a string literal');

    // decoding that can hide a name
    const dec = DECODE.exec(code) ?? BASE64_DECODE.exec(kept);
    if (dec) used.set('decode', dec[0]);

    // tool registrations: literal names only, and not wallet-shaped
    for (const m of kept.matchAll(TOOL_CALL)) {
      const from = m.index!;
      if (/\bfunction\s+tool\s*$/.test(kept.slice(Math.max(0, from - 20), from + 4))) continue;
      const lit = TOOL_LITERAL.exec(kept.slice(from, from + 400).replace(/^\./, ''));
      const name = lit?.[1] ?? lit?.[2];
      if (name === undefined) { bad('tool name is not a string literal, so it cannot be checked'); continue; }
      toolNames.push(name);
      if (name.split(/[_\-.]/).some((w) => WALLETY.has(w.toLowerCase()))) bad(`registers a wallet-like tool name: ${name}`);
    }

    // allowlist: each kind a file uses must be allowed for that file; a file that may fetch may only reach loopback hosts
    for (const [kind, detail] of used) {
      if (allowed.has(kind)) { matched.add(`${f}#${kind}`); continue; }
      const what = kind === 'fetch' ? `outbound network access via ${detail}` : kind === 'socket-module' ? detail
        : kind === 'inbound-http' ? `imports node:http (inbound-http)` : kind === 'child-process' ? `imports node:child_process (child-process)` : `string decoding (${detail}) that can hide a name`;
      bad(`${what}; not on the allowlist for "${kind}" (test/bsv-scan.ts)`);
    }
    if (allowed.has('fetch')) {
      for (const m of kept.matchAll(/https?:\/\/([^\/'"`\s:${}]+)/g)) if (!LOOPBACK.test(m[1]!)) bad(`non-loopback host ${m[1]} in a file that may only reach the local core`);
    }
  }
  return { files, toolNames, violations, matchedAllow: [...matched] };
}
