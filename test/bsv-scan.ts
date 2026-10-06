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
 *
 * Inside the BSV areas (BSV_AREA below: src/core/bsv, ui/src/bsv, src/shared/bsv-*, the Electron admin logic) the scan is stricter about
 * hiding: unicode and hex escapes are decoded before names are matched; literals are folded through + , concat, template parts, join,
 * reverse, replace and slice; a quoted token shaped like a sign / spend / broadcast / inscribe identifier is refused; a computed member
 * built from pieces, a computed CALL (x[k]()), eval, Function, Reflect, `this[...]` / globalThis[...] and look-alike (non-ASCII) letters in
 * code are refused. None of that makes a determined author caught: it makes the casual and the clever-looking evasions fail the build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The code that the stricter anti-obfuscation rules apply to. */
export const BSV_AREA = /^(?:src\/core\/bsv\/|ui\/src\/bsv\/|src\/shared\/bsv-|src\/electron\/admin-logic\.ts$)/;

export type Kind = 'fetch' | 'socket-module' | 'inbound-http' | 'loopback-http-client' | 'child-process' | 'decode';
export type Allow = Record<string, { kinds: Kind[]; reason: string }>;

/** The ONLY file that may contain wallet method names (the four read-only ones), and the default wallet port. */
export const PROBE_FILE = 'src/core/bsv/wallet-probe.ts';
/** The read-only wallet methods the probe may name. Anything else wallet-shaped fails the build, in every file including the probe. */
export const PROBE_METHOD_ALLOWLIST = ['getVersion', 'getNetwork', 'isAuthenticated', 'getHeight'] as const;
/** The one wallet-shaped tool name an agent may have (status only), and the only file that may register it. */
export const ALLOWED_WALLETY_TOOLS: Record<string, string> = { bsv_status: 'src/core/bsv/wallet-tool.ts', bsv_spend_request: 'src/core/bsv/spend.ts' };

/** The ONE file that may name the three spend methods and register the spend tool. Its content hash is pinned (SPEND_PINS): if it differs, the file gets NO exemption. */
export const SPEND_FILE = 'src/core/bsv/spend.ts';
/** The network table, pinned too: the one place (besides policy and the probe) that spells a network. */
export const NETWORKS_FILE = 'src/core/bsv/networks.ts';
/** The only wallet method names spend.ts may quote. It may not name the probe's four (it gets the network from the probe service). */
export const SPEND_METHOD_ALLOWLIST = ['createAction', 'signAction', 'abortAction'] as const;
/**
 * sha256 of the file content with CRLF normalised to LF (and .gitattributes keeps these two files LF). Updating one needs the reviewer's sign-off
 * in the PR; `node scripts/bsv-spend-pin.mjs` prints the current values (it reads two files and nothing else).
 */
export const SPEND_PINS: Record<string, string> = {
  [SPEND_FILE]: 'a3170d2920a36f09a9e7fa96c5887d2e7fbe218575c1cc3536c1993a65d28585', // PROVISIONAL: review nits + build-expired (stale build released) await the reviewer
  [NETWORKS_FILE]: '7c5153e09b10f958a0275a0ea5b535fbccd7b5a1aea418b189e8411e766338c8',
};
/** Files that may spell a network (main / test / live ...) in the BSV area, with the reason. spend.ts, audit.ts and wallet-tool.ts are NOT here: they take the network as an opaque value. */
export const NET_LITERAL_STRICT_FILES = ['src/core/bsv/spend.ts', 'src/core/bsv/audit.ts', 'src/core/bsv/wallet-tool.ts'];
/** Files that may name the mainnet switch route. */
const MAINNET_ROUTE_FILES = /^(?:src\/core\/bsv\/(?:mainnet-routes|index)\.ts|src\/electron\/(?:admin-logic|main)\.ts|ui\/src\/bsv\/[^/]+)$/;
/** Files that may name an importer-restricted symbol. */
const HTTP_TRANSPORT_FILES = new Set(['src/core/bsv/wallet-probe.ts', 'src/core/bsv/index.ts', SPEND_FILE]);
/** Policy calls the spend path may never make: it can only make things safer. */
const SPEND_POLICY_FORBIDDEN = /\bsetMainnetEnabled\b|\bunfreeze\b|\bsetCaps\b|\bsetAllowlist\b|\.\s*arm\s*\(/;
const NET_LITERAL_TOKEN = /(['"`])(?:main|mainnet|test|testnet|live)\1/i;
const NET_LITERAL_KEY = /[{,]\s*(?:main|mainnet|test|testnet|live)\s*:/i;
const NET_LITERAL_MEMBER = /\.\s*(?:main|mainnet|test|testnet|live)\b(?!\s*\()/i;

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
  'src/core/blender/sandbox.ts': { kinds: ['decode'], reason: 'the sandbox runner decodes base64 file contents that boat.dev returns for binary exports (GLB, PNG) before they are written to the task workspace; the bytes are never interpreted' },
  'src/core/blender/system.ts': { kinds: ['fetch', 'child-process'], reason: 'Blender setup, only when the Set up / Test / Launch button is pressed: one https download of the backend from the address in blender.advanced (public https hosts only), the same download routine for the one pinned portable Blender (the address and sha256 are constants in src/shared/blender.ts, started only by the Get Blender for Legion button after an approval card), and the Poly Haven asset downloads of the Sculptor (api.polyhaven.com and its file hosts only, https and public hosts only, a host allowlist checked on every redirect hop, a 5 MB cap on listings, only after the asset source is switched on in Settings and, for a download, an approval card), starting Blender, tar or reg as child processes; and, only after the user approves a script card, one headless Blender process on this computer (argument list, no shell, scrubbed environment, stopped by PID tree)' },
  'src/core/providers/http.ts': { kinds: ['fetch'], reason: 'the model-provider client: reaches only the address of a provider the owner configured and enabled (https, or http for this computer only), follows no redirect, sends the key only to the origin it was saved for, with timeouts and size caps; every request goes through providerRequest, and test/providers-http.test.ts holds those rules' },
  'src/core/providers/external-mcp.ts': { kinds: ['fetch'], reason: "Legion's own MCP client for the servers the owner added in Settings, used only for a run on a model provider: an http or sse server (https, or this computer; no redirect followed) and a stdio server, which the MCP SDK's stdio transport starts as the owner's own configured command with the SDK's small default environment plus the env entries the owner wrote for it. No other providers file may import the stdio transport (test/providers-tripwire.test.ts)." },
  'src/core/updater/net.ts': { kinds: ['fetch'], reason: 'the update check and download: GET only, https to github.com and GitHub\'s two release-asset hosts (the policy constant in src/core/updater/config.ts, checked on every request and every redirect hop), no credentials, no cookies, size-capped, hashed while streaming' },
  'src/core/updater/apply.ts': { kinds: ['fetch', 'child-process'], reason: 'the update apply helper, run only after the app has exited: polls the new build\'s /health on 127.0.0.1, starts the app again (the same command as the shortcut), and on a failed first start stops the new build by PID (taskkill or a signal); it renames only the code-set folders inside the install folder' },
  'src/electron/updater-main.ts': { kinds: ['child-process'], reason: 'starts the apply helper (the installed Electron binary in node mode) detached, after the core reported an approved update ready and idle (or after a native Restart now confirmation); starts nothing else' },
  'src/core/browser/cdp.ts': { kinds: ['fetch'], reason: "the browser tool's CDP client: one WebSocket to ws://127.0.0.1:<port> only (the address is checked against a loopback-only pattern before every connect), a fixed list of CDP method names, size and time caps; talks to the Chromium-family browser Legion started for the run (its debugging port, read from DevToolsActivePort)" },
  'src/core/browser/resolve.ts': { kinds: ['socket-module'], reason: 'the browser tool\'s DNS check: node:dns lookup of the host of a page address, so the answers can be run through the same address rules (loopback, private, metadata, wallet port) before a page is opened; it opens no connection to the answer' },
  'src/core/comms/scrub.ts': { kinds: ['decode'], reason: 'the secret detector decodes base64 and rot13 candidates to find seed phrases hidden in them' },
  [PROBE_FILE]: { kinds: ['loopback-http-client'], reason: 'the read-only wallet STATUS probe: one POST per allowlisted method to a loopback address, never a server, never another host (rules below)' },
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

/** Decodes \uXXXX, \u{X...} and \xHH escapes, so `'\u0073ign'` is read as `'sign'` (an identifier can be spelled that way too). */
export function unescapeLiterals(src: string): string {
  const chr = (n: number) => { try { return String.fromCodePoint(n); } catch { return ''; } };
  return src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => chr(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => chr(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => chr(parseInt(h, 16)));
}

/**
 * Joins the ways a name is spelled in pieces, so a token check sees the name: 'a'+'b', 'a'.concat('b', 'c'), ['a','b'].join(''),
 * `${'a'}b`, 'ba'.split('').reverse().join(''), 'aXb'.replace('X', ''), 'xab'.slice(1), ['a','b'][0]. Only literals are folded: what is
 * assembled from variables is out of reach (the BSV-area rules refuse the shapes that would use it, see scanTree).
 */
export function joinLiterals(src: string): string {
  let s = src;
  for (let pass = 0; pass < 8; pass++) {
    const before = s;
    s = s.replace(/\$\{\s*(['"`])([^'"`\\\n]*)\1\s*\}/g, '$2');
    s = s.replace(/(['"`])\s*\+\s*(['"`])/g, '');
    // 'a'.concat('b', 'c')  ->  'abc'
    s = s.replace(/(['"`])([^'"`\\\n]*)\1\s*\.concat\(\s*((?:(['"`])[^'"`\\\n]*\4\s*,?\s*)+)\)/g, (_m, _q: string, a: string, args: string) => {
      const parts = [...args.matchAll(/(['"`])([^'"`\\\n]*)\1/g)].map((m) => m[2]!);
      return `"${a}${parts.join('')}"`;
    });
    s = s.replace(/\[((?:\s*(['"`])[^'"`\\\n]*\2\s*,?)+)\]\s*(\.reverse\(\)\s*)?\.join\(\s*(['"`])([^'"`\\\n]*)\4\s*\)/g, (_m, items: string, _q: string, rev: string | undefined, _q2: string, sep: string) => {
      const parts = [...items.matchAll(/(['"`])([^'"`\\\n]*)\1/g)].map((m) => m[2]!);
      if (rev) parts.reverse();
      return `"${parts.join(sep)}"`;
    });
    // 'ba'.split('').reverse().join('')
    s = s.replace(/(['"`])([^'"`\\\n]*)\1\s*\.split\(\s*(['"`])\3\s*\)\s*\.reverse\(\s*\)\s*\.join\(\s*(['"`])\4\s*\)/g, (_m, _q: string, a: string) => `"${[...a].reverse().join('')}"`);
    // 'aXb'.replace('X', '') and replaceAll
    s = s.replace(/(['"`])([^'"`\\\n]*)\1\s*\.replace(All)?\(\s*(['"`])([^'"`\\\n]*)\4\s*,\s*(['"`])([^'"`\\\n]*)\6\s*\)/g, (_m, _q: string, a: string, all: string | undefined, _q2: string, from: string, _q3: string, to: string) => `"${from === '' ? a : all ? a.split(from).join(to) : a.replace(from, () => to)}"`);
    // 'xab'.slice(1) / .substring(1, 3) / .substr(1, 2)
    s = s.replace(/(['"`])([^'"`\\\n]*)\1\s*\.(slice|substring|substr)\(\s*(\d{1,3})\s*(?:,\s*(\d{1,3})\s*)?\)/g, (_m, _q: string, a: string, fn: string, x: string, y: string | undefined) => {
      const i = Number(x); const j = y === undefined ? undefined : Number(y);
      return `"${fn === 'substr' ? a.substr(i, j) : a.slice(i, j)}"`;
    });
    // ['a', 'b'][1]
    s = s.replace(/\[((?:\s*(['"`])[^'"`\\\n]*\2\s*,?)+)\]\s*\[\s*(\d{1,2})\s*\]/g, (_m, items: string, _q: string, idx: string) => {
      const parts = [...items.matchAll(/(['"`])([^'"`\\\n]*)\1/g)].map((m) => m[2]!);
      return `"${parts[Number(idx)] ?? ''}"`;
    });
    if (s === before) break;
  }
  return s;
}

/** Escapes decoded, then literals folded: the text every name rule is matched against. */
export const normalize = (src: string): string => joinLiterals(unescapeLiterals(src));

// ------------------------------------------------------------------ the rules

/** Names that no source may contain anywhere (comments included, spelled in pieces included). The wallet port is allowed in the probe file only. */
const FORBIDDEN = /walletclient|httpwalletjson|@bsv\/sdk/i;
/** `createAction` is forbidden everywhere except in the pinned spend file (checked per file). */
const CREATE_ACTION = /createaction/i;
const WALLET_PORT = /(?<![\w.])3321(?!\w)/;
/**
 * Every other BRC-100 method name that can sign, spend, reveal a balance, a key, a certificate or an address, or that blocks on the wallet's
 * own UI. Forbidden everywhere, the probe file included (the probe's own documentation lives in docs/BSV-WALLET-DESIGN.md). The generic
 * names encrypt/decrypt/createHmac/verifyHmac are not scanned: node:crypto and the UI have the same words; the probe cannot send them anyway
 * (its method list is checked at the point of use and on the wire by test/bsv-wallet-probe.test.ts).
 */
const WALLET_METHODS_FORBIDDEN = /\b(?:internalizeAction|listActions|listOutputs|relinquishOutput|getPublicKey|revealCounterpartyKeyLinkage|revealSpecificKeyLinkage|createSignature|verifySignature|acquireCertificate|listCertificates|proveCertificate|relinquishCertificate|discoverByIdentityKey|discoverByAttributes|waitForAuthentication|getHeaderForHeight)\b/i;
/** A quoted camelCase name shaped like a wallet method (get/is/create/sign/...): outside the probe the four read-only names fail as quoted strings, inside it only they pass. */
const METHOD_SHAPED = /^(?:get|is|create|sign|abort|internalize|list|relinquish|reveal|verify|acquire|prove|discover|wait|encrypt|decrypt)[A-Z][A-Za-z]{2,40}$/;
const FOUR = new Set<string>(PROBE_METHOD_ALLOWLIST);
/** Globals that reach the network; a string literal naming one is a computed-access attempt. */
const NET_GLOBAL_NAME = /['"`](?:fetch|XMLHttpRequest|WebSocket|EventSource)['"`]/;
const COMPUTED_GLOBAL = /\b(?:globalThis|global|window|self)\s*\[|\bReflect\s*\.\s*get\s*\(\s*(?:globalThis|global|window|self)\b/;
/** Rules over `code` (comments and string bodies removed) that apply in the BSV areas only. Each is a way to reach a name the scan cannot read. */
const AREA_CODE_RULES: Array<[RegExp, string]> = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b|(?<![\w.$])Function\s*\(/, 'the Function constructor'],
  [/\bsetTimeout\s*\(\s*""|\bsetInterval\s*\(\s*""/, 'a timer given a string of code'],
  [/\bReflect\b/, 'Reflect'],
  [/\bwith\s*\(/, 'a with statement'],
  [/\b(?:Object\s*\.\s*(?:getOwnPropertyDescriptors?|setPrototypeOf|defineProperty|defineProperties)|__proto__|__defineGetter__|__lookupGetter__)\b/, 'prototype or descriptor access'],
  [/\.\s*constructor\s*[.(\[]/, 'reaching a constructor through an instance'],
  [/\b(?:globalThis|global|window|self|this|process|module|exports|arguments)\s*\[/, 'a computed member of a global or `this`'],
  [/\b(?:globalThis|global|window|self)\b[^;{}\n]*\)\s*\[/, 'a computed member of a cast global object'],
  [/\]\s*\(/, 'a computed call x[k](...): the method it invokes cannot be read'],
  [/\bimport\s*\.\s*meta\b|\brequire\s*\.\s*(?:cache|main)\b/, 'module internals'],
  [/\b(?:vm|worker_threads)\b/, 'a code-running module'],
];
/** What a quoted identifier-shaped token may not be in the BSV areas. (`spend` alone is a word the policy code uses in text; as a bare property name it is not.) */
const HIDDEN_IDENT_ANYCASE = /^(?:sign\w*|broadcast\w*|inscribe\w*|createAction|WalletClient|wif|privateKey|private_key|mnemonic|seedPhrase|xprv|spend|spending)$/i;
const HIDDEN_IDENT_CAMEL = /^(?:spend[A-Z_]\w*|send\w*Transaction)$/;
const HIDDEN_IDENT = { test: (w: string): boolean => HIDDEN_IDENT_ANYCASE.test(w) || HIDDEN_IDENT_CAMEL.test(w) };
/** `file#name` pairs that are real and reviewed: the two spend method names in the pinned spend file. */
const HIDDEN_IDENT_OK = new Set<string>([`${SPEND_FILE}#createAction`, `${SPEND_FILE}#signAction`]);
const SPEND_ONLY_METHODS = /\b(?:signAction|abortAction)\b/i;
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
/** Loopback hosts, plus `legion.local`: the originator name Legion declares to a wallet (an Origin header value, never a place it connects to). */
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\]|legion\.local)$/;

const normHash = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/** Scans `root`/src and `root`/ui/src. `allow` defaults to ALLOWLIST. `opts.pins` replaces SPEND_PINS (tests prove the RULES reject a planted file even when its hash is pinned). */
export function scanTree(root: string, allow: Allow = ALLOWLIST, opts: { pins?: Record<string, string> } = {}): ScanResult {
  const pins = opts.pins ?? SPEND_PINS;
  const files: string[] = [];
  for (const r of ROOTS) walk(root, r, files);
  const violations: string[] = [];
  const toolNames: string[] = [];
  const matched = new Set<string>();

  for (const p of Object.keys(pins)) if (!files.includes(p) || !existsSync(join(root, p))) violations.push(`${p}: pinned in SPEND_PINS but missing (a pin or tool entry with no file is a dead allowance)`);

  for (const f of files) {
    const raw = readFileSync(join(root, f), 'utf8');
    const { kept, code } = lex(raw);
    // pinned files: a hash that differs from the pin means the file is unreviewed; it then gets none of the exemptions below
    const pinned = pins[f];
    const pinOk = pinned !== undefined && normHash(raw) === pinned;
    if (pinned !== undefined && !pinOk) violations.push(`${f}: differs from the reviewed pin; re-review and update SPEND_PINS (sha256 ${normHash(raw).slice(0, 12)}...)`);
    const isSpend = f === SPEND_FILE && pinOk;
    const joinedRaw = normalize(raw);
    const joinedKept = normalize(kept);
    const allowed = new Set(allow[f]?.kinds ?? []);
    const used = new Map<Kind, string>();
    const bad = (m: string) => violations.push(`${f}: ${m}`);

    // names that never belong anywhere (comments included)
    const tok = FORBIDDEN.exec(joinedRaw);
    if (tok) bad(`contains ${tok[0]}`);
    if (!isSpend) {
      const ca = CREATE_ACTION.exec(joinedRaw);
      if (ca) bad(`contains ${ca[0]} (only the pinned spend module ${SPEND_FILE} may name it)`);
      const so = SPEND_ONLY_METHODS.exec(joinedRaw);
      if (so) bad(`contains the wallet method name ${so[0]} (only the pinned spend module ${SPEND_FILE} may name it)`);
    }
    const meth = WALLET_METHODS_FORBIDDEN.exec(joinedRaw);
    if (meth) bad(`contains the wallet method name ${meth[0]} (only the four read-only status methods may exist, and only in ${PROBE_FILE})`);
    const port = WALLET_PORT.exec(joinedRaw);
    if (port) bad(`contains ${port[0]} (there is no default wallet port: the owner types the address, so no source names one)`);
    // quoted method-shaped strings: outside the probe none of the four may appear; inside it nothing but the four
    for (const m of joinedKept.matchAll(/(['"`])([A-Za-z]{5,48})\1/g)) {
      const w = m[2]!;
      if (!METHOD_SHAPED.test(w)) continue;
      if (isSpend ? !(SPEND_METHOD_ALLOWLIST as readonly string[]).includes(w) : f === PROBE_FILE ? !FOUR.has(w) : FOUR.has(w) || (SPEND_METHOD_ALLOWLIST as readonly string[]).includes(w)) bad(`names the wallet method "${w}" in a string${f === PROBE_FILE ? ' (the probe may name only ' + PROBE_METHOD_ALLOWLIST.join(', ') + ')' : ` (wallet method names belong in ${PROBE_FILE} only)`}`);
    }

    // the BSV areas: no way of spelling a sign / spend / broadcast / inscribe name, or of reaching one at run time, that the scan cannot read
    if (BSV_AREA.test(f)) {
      for (const [re, what] of AREA_CODE_RULES) { const m = re.exec(code); if (m) bad(`${what} ("${m[0].slice(0, 40).replace(/\s+/g, ' ')}")`); }
      const nonAscii = /[^\x00-\x7e]/.exec(code);
      if (nonAscii) bad(`a non-ASCII character (U+${nonAscii[0].codePointAt(0)!.toString(16).padStart(4, '0')}) in code, outside a string or comment: look-alike letters can spell a forbidden name`);
      // a quoted token shaped like an identifier (no spaces) that names something that signs, spends, broadcasts or inscribes. Prose strings have spaces and pass.
      for (const m of joinedKept.matchAll(/(['"`])([A-Za-z_$][\w$]{2,60})\1/g)) {
        if (HIDDEN_IDENT.test(m[2]!) && !HIDDEN_IDENT_OK.has(`${f}#${m[2]}`)) bad(`a quoted name "${m[2]}" that signs, spends, broadcasts or inscribes (a string used as a property or method name hides it from the identifier scan)`);
      }
      // a computed member built from pieces: x['si' + 'gn'], x[`${a}b`], x[parts.join('')]
      const pieces = /(?<=[\w$)\]])\[[^\]\[\n]*(?:""[^\]\[\n]*\+|\+[^\]\[\n]*""|\.join\s*\(|\.concat\s*\(|\bString\b)[^\]\[\n]*\]/.exec(code);
      if (pieces) bad(`a computed member built from pieces ("${pieces[0].slice(0, 40)}"): the name it reaches cannot be read`);
      if (/(?<=[\w$)\]])\[\s*`[^`\n]*\$\{/.test(kept)) bad('a computed member built from a template literal: the name it reaches cannot be read');
    }

    // the network table and the spend path: opaque networks, a one-way policy API, one importer list for the transport
    if (NET_LITERAL_STRICT_FILES.includes(f)) {
      const lit = NET_LITERAL_TOKEN.exec(joinedKept) ?? NET_LITERAL_KEY.exec(code) ?? NET_LITERAL_MEMBER.exec(code);
      if (lit) bad(`spells a network ("${lit[0].trim()}"): this file takes the network as an opaque value and looks everything up through NET[net]`);
    }
    if (f === SPEND_FILE) { const pf = SPEND_POLICY_FORBIDDEN.exec(code); if (pf) bad(`the spend path calls "${pf[0].trim()}" on the policy: it may only make things safer (evaluate, approve, deny, settle, resolveUnknown, status, snapshot, freeze, disarm, mainnetOff, voidPending, canSign)`); }
    if (f !== 'src/core/bsv/policy.ts' && f !== 'src/core/bsv/mainnet-routes.ts' && /\bsetMainnetEnabled\b/.test(code)) bad('names setMainnetEnabled (only policy.ts and mainnet-routes.ts may)');
    if (!MAINNET_ROUTE_FILES.test(f) && joinedKept.includes('/api/bsv/policy/mainnet')) bad('names the mainnet switch route (only mainnet-routes.ts, the Electron admin logic and main, index.ts and the UI store may)');
    if (!HTTP_TRANSPORT_FILES.has(f) && /\bhttpTransport\b/.test(code)) bad('names httpTransport (only wallet-probe.ts, index.ts and spend.ts may)');
    if (f === NETWORKS_FILE) {
      for (const m of joinedKept.matchAll(/(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*['"`]([^'"`]+)['"`]/g)) if (m[1] !== 'node:crypto') bad(`imports ${m[1]} (the network table imports only node:crypto)`);
    }

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
      if (name.split(/[_\-.]/).some((w) => WALLETY.has(w.toLowerCase())) && ALLOWED_WALLETY_TOOLS[name] !== f) bad(`registers a wallet-like tool name: ${name}`);
    }

    // allowlist: each kind a file uses must be allowed for that file; a file that may fetch may only reach loopback hosts
    for (const [kind, detail] of used) {
      if (allowed.has(kind)) { matched.add(`${f}#${kind}`); continue; }
      // the probe's HTTP client: node:http is fine in a file that is allowed to be a loopback client, as long as it never listens
      if (kind === 'inbound-http' && allowed.has('loopback-http-client')) {
        matched.add(`${f}#loopback-http-client`);
        if (/\bcreateServer\b/.test(code)) bad('a loopback http client may not create a server');
        continue;
      }
      const what = kind === 'fetch' ? `outbound network access via ${detail}` : kind === 'socket-module' ? detail
        : kind === 'inbound-http' ? `imports node:http (inbound-http)` : kind === 'child-process' ? `imports node:child_process (child-process)` : `string decoding (${detail}) that can hide a name`;
      bad(`${what}; not on the allowlist for "${kind}" (test/bsv-scan.ts)`);
    }
    if (allowed.has('fetch') || allowed.has('loopback-http-client')) {
      for (const m of kept.matchAll(/https?:\/\/([^\/'"`\s:${}]+)/g)) if (!LOOPBACK.test(m[1]!)) bad(`non-loopback host ${m[1]} in a file that may only reach the local core`);
    }
  }
  return { files, toolNames, violations, matchedAllow: [...matched] };
}
