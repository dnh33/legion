/**
 * Static check for Blender Python scripts. A conservative FILTER, not a sandbox: it reads the script as tokens (a Python tokenizer
 * written here, with f-string expressions scanned too) and refuses what it cannot show to be harmless. Default stance: when in doubt, block.
 *
 * What it blocks (see docs/BLENDER.md for the full list and the limits):
 *  - imports outside a small allowlist; os, sys, subprocess, socket, ctypes, importlib, io, pickle ... also as bare names or attributes
 *  - eval, exec, compile, open, input, __import__, globals, locals, vars; dunder and private attribute access; frame and loader attributes
 *  - getattr / setattr / hasattr / delattr unless the attribute name is a plain literal that passes the same rules
 *  - file paths: every path argument (any keyword whose name says path, dir, file or folder; .load(), .save() ...) and every assignment
 *    to such an attribute (plain, tuple, for, with, augmented; setattr is refused for those names) must be a plain string literal inside
 *    the allowed directories (or "//" next to the .blend in the sandbox), or LEGION_EXPORT_DIR + "/name"; built strings, variables and ".." are refused
 *  - bpy.ops: no aliasing; an ALLOWLIST of namespaces (modelling, materials, render to file, import/export), a short list for wm, image and
 *    render; in live Blender no operator that loads a .blend (open_mainfile, append, link ...)
 *  - Blender features that run strings or outlive the script: driver expressions, handlers, timers, add-on and preference access,
 *    Text.as_module / use_module, typing.get_type_hints / ForwardRef, use_scripts=
 *
 * What it cannot do: stop a script that wrecks the open scene, loops forever or eats memory; know every Blender API that evaluates a
 * string; see through a string built at run time and used by an API it does not know. The approval card, the .blend backup and the
 * VM sandbox exist because of those limits.
 */
import { createHash } from 'node:crypto';

export const MAX_SCRIPT_BYTES = 100_000;
const MAX_TOKENS = 60_000;
const MAX_FSTRING_DEPTH = 3;
/** The variable every script may use for the export folder. The guard defines it when it runs the script. */
export const EXPORT_DIR_VAR = 'LEGION_EXPORT_DIR';

export interface Finding { rule: string; line: number; detail: string; snippet?: string }
export interface CheckOptions {
  /** Absolute folders a literal path may point into (the export folder; for a VM run, the VM work folder). */
  allowedDirs: string[];
  /**
   * True for a script that runs in the user's open Blender. Live scripts may not use "//" paths (next to the user's own .blend, not the
   * export folder) and may not load a .blend (open_mainfile, append, link ...): a .blend can carry runnable code.
   */
  live?: boolean;
}
export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  /** Things that are allowed but worth a human's eye; shown on the approval card. */
  notes: string[];
  lines: number;
  bytes: number;
}

export const scriptHash = (script: string): string => createHash('sha256').update(script, 'utf8').digest('hex');

// ---------------------------------------------------------------------------------------------------------------------------------
// Allow and deny lists
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Modules a script may import (root names). Anything else is refused. Left out on purpose: numpy (many file and library loaders), typing
 * (get_type_hints and ForwardRef evaluate strings), bpy_extras (io_utils and image_utils do file IO under other argument names), gpu, gpu_extras and blf.
 */
export const ALLOWED_MODULES = new Set([
  'bpy', 'bmesh', 'mathutils', 'idprop',
  'math', 'random', 'time', 'colorsys', 'itertools', 'functools', 'operator', 'collections', 'dataclasses', 'enum',
  're', 'json', 'string', 'textwrap', 'copy', 'statistics', 'heapq', 'bisect', 'array', 'decimal', 'fractions', '__future__',
]);

/** Module names refused as imports and as bare names (a bare name can come from `from bpy_extras.io_utils import os`). */
const BANNED_MODULES = [
  'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'importlib', 'ctypes', 'urllib', 'http', 'ftplib', 'smtplib', 'telnetlib',
  'ssl', 'requests', 'httpx', 'builtins', 'io', 'tempfile', 'glob', 'zipfile', 'tarfile', 'pickle', 'marshal', 'shelve', 'base64',
  'binascii', 'codecs', 'inspect', 'types', 'gc', 'code', 'codeop', 'runpy', 'platform', 'multiprocessing', 'threading', 'asyncio',
  'concurrent', 'webbrowser', 'sqlite3', 'shlex', 'pty', 'signal', 'resource', 'mmap', 'fcntl', 'posix', 'nt', 'winreg', 'msvcrt',
  'pwd', 'grp', 'getpass', 'imp', 'pkgutil', 'zipimport', 'site', 'sysconfig', 'pip', 'cffi', 'atexit', 'logging', 'tkinter',
  'xmlrpc', 'addon_utils', 'ast', 'dis', 'numpy', 'scipy', 'fnmatch', 'filecmp', 'stat', 'netrc', 'cgi', 'select', 'selectors',
  'sched', 'trace', 'pdb', 'faulthandler', 'tracemalloc', 'sqlite', 'ensurepip', 'venv', 'distutils', 'setuptools',
  'typing', 'bpy_extras',
];
/** Words that are also ordinary Blender or variable names (bpy.types, vertex.select, code ...): not banned as bare names or attributes; the import rule already keeps the real modules out. */
const GENERIC_WORDS = new Set(['types', 'code', 'select', 'stat', 'trace', 'resource', 'signal', 'site', 'ast', 'dis', 'cgi', 'sched', 'glob', 'http', 'imp']);
const BANNED_BARE_EXTRA = [
  'eval', 'exec', 'compile', 'open', 'input', 'breakpoint', 'exit', 'quit', 'help', 'globals', 'locals', 'vars', 'execfile',
  'reload', 'SystemExit', 'copyright', 'credits', 'license', 'get_type_hints', 'ForwardRef',
];
export const BANNED_BARE = new Set<string>([...BANNED_MODULES.filter((m) => !GENERIC_WORDS.has(m)), ...BANNED_BARE_EXTRA]);

/** Banned only when called: scene.unit_settings.system is an ordinary property. */
const CALL_ONLY_ATTRS = new Set([
  'system', 'popen', 'Popen', 'startfile', 'fork', 'forkpty', 'kill', 'killpg', 'execl', 'execle', 'execlp', 'execlpe', 'execv', 'execve',
  'execvp', 'execvpe', 'spawn', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe',
]);
const BANNED_ATTR_EXTRA = [
  // process and library execution
  'eval', 'exec', 'execfile', 'exec_module', 'load_module', 'import_module', 'find_spec',
  'spec_from_file_location', 'CDLL', 'cdll', 'windll', 'WinDLL', 'LoadLibrary', 'dlopen', 'open',
  // frames, loaders, interpreter state
  'modules', 'meta_path', 'path_hooks', 'f_globals', 'f_locals', 'f_builtins', 'f_back', 'f_code', 'gi_frame', 'gi_code', 'gi_yieldfrom',
  'cr_frame', 'cr_code', 'ag_frame', 'ag_code', 'tb_frame', 'tb_next', 'co_code', 'func_globals',
  // string-driven attribute access
  'attrgetter', 'methodcaller', 'format_map', 'vformat', 'get_field', 'formatter_field_name_split',
  // Blender features that evaluate strings, outlive the script, or load code and settings
  'driver_add', 'expression', 'driver_namespace', 'handlers', 'timers', 'addons', 'preferences', 'user_preferences', 'libraries',
  'python_file_run', 'run_script', 'load_scripts', 'use_scripts_auto_execute', 'script_paths_extra', 'unpack', 'sleep',
  // strings that run as code, text blocks that carry code, persistent callbacks, key-config and CLI registration
  'as_module', 'use_module', 'get_type_hints', 'ForwardRef', 'use_scripts', 'texts', 'msgbus', 'draw_handler_add',
  'keyconfig_import', 'keyconfig_export', 'register_cli_command', 'unregister_cli_command', 'register_tool', 'register_manual_map',
  'register_preset_path', 'path_reference_copy', 'load_image', 'io_utils', 'image_utils',
];
/** Names refused wherever they appear, also as keyword arguments (use_scripts=True lets a .blend run its own scripts). */
const ALWAYS_BANNED_NAMES: Record<string, { rule: string; detail: string }> = {
  as_module: { rule: 'string-code', detail: 'Text.as_module() runs a text block as a Python module' },
  use_module: { rule: 'string-code', detail: 'text.use_module registers a text block to run as a module when a .blend is opened' },
  get_type_hints: { rule: 'string-code', detail: 'typing.get_type_hints evaluates strings as code' },
  ForwardRef: { rule: 'string-code', detail: 'typing.ForwardRef compiles and evaluates strings as code' },
  use_scripts: { rule: 'use-scripts', detail: 'use_scripts lets a .blend file run its own scripts when it is opened, appended or linked' },
};
export const BANNED_ATTRS = new Set<string>([...BANNED_MODULES.filter((m) => !GENERIC_WORDS.has(m)), ...BANNED_ATTR_EXTRA]);

const BARE_DUNDER_OK = new Set([
  '__name__', '__init__', '__doc__', '__str__', '__repr__', '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__', '__hash__',
  '__len__', '__iter__', '__next__', '__getitem__', '__setitem__', '__contains__', '__call__', '__enter__', '__exit__', '__bool__',
  '__add__', '__sub__', '__mul__', '__truediv__', '__neg__', '__slots__', '__future__', '__annotations__',
]);
const ATTR_DUNDER_OK = new Set(['__init__', '__name__', '__doc__']);

/** bpy.ops namespaces refused outright (named so the message can say why); everything not on the allowlist below is refused too. */
const DENIED_OPS_NS = new Set(['script', 'text', 'console', 'preferences', 'extensions', 'file', 'buttons']);
/**
 * bpy.ops namespaces a script may use: modelling, materials, scene data and import/export. This is an ALLOWLIST: an installed add-on's
 * operators (blendermcp.*, anything an extension registers), screen, sequencer, clip, ptcache, fluid bake and the like are refused.
 */
const ALLOWED_OPS_NS = new Set([
  'object', 'mesh', 'curve', 'surface', 'material', 'node', 'uv', 'transform', 'collection', 'anim', 'constraint', 'armature', 'pose',
  'sculpt', 'lattice', 'particle', 'rigidbody', 'cloth', 'scene', 'world', 'texture', 'grease_pencil', 'mball', 'font', 'geometry',
  // namespaces below have a narrower list in OPS_SUBLIST
  'wm', 'image', 'render', 'outliner',
  // import and export operators registered by Blender's bundled io add-ons
  'export_scene', 'import_scene', 'export_mesh', 'import_mesh', 'export_anim', 'import_anim', 'export_curve', 'import_curve', 'import_image',
]);
/** Namespaces where only these operators are allowed. The rest of wm opens files, edits preferences, opens URLs and programs, or evals strings (context_set_*). */
const WM_ALLOWED = new Set([
  'save_mainfile', 'save_as_mainfile', 'open_mainfile', 'append', 'link', 'read_homefile',
  'obj_export', 'obj_import', 'ply_export', 'ply_import', 'stl_export', 'stl_import', 'usd_export', 'usd_import', 'alembic_export',
  'alembic_import', 'collada_export', 'collada_import', 'gpencil_export_svg', 'gpencil_export_pdf', 'gpencil_import_svg',
]);
const OPS_SUBLIST: Record<string, Set<string>> = {
  wm: WM_ALLOWED,
  image: new Set(['new', 'open', 'save_as', 'save', 'pack', 'invert', 'flip', 'resize', 'reload', 'clear']),
  render: new Set(['render', 'opengl']),
  outliner: new Set(['delete', 'orphans_purge', 'collection_new', 'collection_delete', 'item_activate']),
};
const DENIED_OPS = new Set(['image.external_edit', 'image.project_edit', 'image.project_apply', 'render.view_show', 'render.play_rendered_anim', 'wm.read_factory_settings', 'node.shader_script_update']);
/** Operators whose NAME is a banned attribute word only because it is ordinary Blender vocabulary (image.open opens an image). */
const OPS_BANNED_OK = new Set(['image.open', 'font.open']);
const OPS_REPLACES_SCENE = new Set(['wm.open_mainfile', 'wm.read_homefile', 'wm.read_factory_settings', 'wm.revert_mainfile']);
/** In LIVE Blender these load a .blend, which can carry runnable code (text modules, drivers, handlers); nothing in the export folder may be opened that way. */
const LIVE_BLEND_LOAD = new Set(['wm.open_mainfile', 'wm.append', 'wm.link', 'wm.read_homefile', 'wm.revert_mainfile']);

/** Keyword and attribute names that carry a file path: anything that says path, dir, file or folder. The value must be a plain literal inside the allowed folders. */
const PATH_NAME = /(^|_)(path|paths|dir|dirs|dirname|directory|file|files|filename|filepath|folder|output)(_|$)|filepath|directory|dirpath|outpath/i;
/** Names that look like a path name but are enums, switches or filters (file_format, path_mode, use_file_extension, filter_folder, data_path). */
const PATH_NAME_EXEMPT = /(_mode|_format|_type|_extension|_ext|_count|_size)$|^(use|is|has|show|filter|check)_|^(data|rna|bone|fcurve)_path$/i;
const isPathName = (n: string): boolean => PATH_NAME.test(n) && !PATH_NAME_EXEMPT.test(n);
/** Keyword names that are sinks although they do not say path, dir, file or folder. */
const SINK_KWARG_OLD = new Set(['output', 'outpath', 'export_path', 'import_path', 'texture_dir', 'cache_path', 'library_path', 'audio_filepath', 'base_path']);
/** Method names whose first positional argument is a path. */
const SINK_CALLS = new Set(['load', 'save', 'save_render', 'save_as', 'export', 'read_file']);
/** Method names whose SECOND positional argument is a path (sequencer strips). */
const SINK_CALLS_ARG2 = new Set(['new_movie', 'new_sound', 'new_image']);

// ---------------------------------------------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------------------------------------------

type Kind = 'name' | 'num' | 'str' | 'op' | 'nl';
interface Tok {
  k: Kind; v: string; line: number;
  /** For strings: the decoded text, or null when it cannot be known (f-string, bytes, \N{...}). */
  value?: string | null;
  isF?: boolean;
  /** For strings: the body between the quotes (undecoded). */
  body?: string;
  /** Bracket partner index (for ( [ { ) ] }). */
  pair?: number;
  /** Set on parentheses that open a def or lambda parameter list. */
  defParen?: boolean;
}

class ScanError extends Error { constructor(public readonly line: number, msg: string) { super(msg); } }

const NAME_START = /[\p{L}\p{Nl}_]/u;
const NAME_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_]/u;
const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['->', ':=', '==', '!=', '<=', '>=', '**', '//', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '@=', '&=', '|=', '^='];
const OPS1 = '+-*/%@&|^~<>()[]{},:.;=';
const OPEN = new Set(['(', '[', '{']);
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function decodeEscapes(body: string): string | null {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = body[i + 1];
    if (n === undefined) { out += '\\'; break; }
    i++;
    switch (n) {
      case '\n': break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'x': { const h = body.slice(i + 1, i + 3); if (!/^[0-9a-fA-F]{2}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); i += 2; break; }
      case 'u': { const h = body.slice(i + 1, i + 5); if (!/^[0-9a-fA-F]{4}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); i += 4; break; }
      case 'U': { const h = body.slice(i + 1, i + 9); if (!/^[0-9a-fA-F]{8}$/.test(h)) return null; const cp = parseInt(h, 16); if (cp > 0x10ffff) return null; out += String.fromCodePoint(cp); i += 8; break; }
      case 'N': return null;
      default:
        if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(body.slice(i)); out += String.fromCharCode(parseInt(m![0], 8)); i += m![0].length - 1; }
        else out += '\\' + n;
    }
  }
  return out;
}

/** Expression source of each `{...}` replacement field in an f-string body (nested format specs included). Throws on anything it cannot follow. */
function fExpressions(body: string, line: number): string[] {
  const out: string[] = [];
  const scanField = (start: number): number => {
    // body[start] is just after '{'. Returns the index just after the matching '}'.
    let i = start;
    let depth = 0;
    let exprEnd = -1;
    while (i < body.length) {
      const c = body[i]!;
      if (c === '\\') throw new ScanError(line, 'backslash inside an f-string expression');
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        while (i < body.length && body[i] !== q) i++;
        if (i >= body.length) throw new ScanError(line, 'unterminated string inside an f-string expression');
        i++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
      if (c === ')' || c === ']') { depth--; i++; continue; }
      if (c === '}') {
        if (depth > 0) { depth--; i++; continue; }
        if (exprEnd < 0) exprEnd = i;
        out.push(body.slice(start, exprEnd));
        return i + 1;
      }
      if (depth === 0 && exprEnd < 0) {
        if (c === '!' && body[i + 1] !== '=') { exprEnd = i; i++; continue; }
        if (c === ':') {
          exprEnd = i;
          // format spec: may hold nested {fields}; scan it for them
          i++;
          while (i < body.length && body[i] !== '}') {
            if (body[i] === '{') { i = scanField(i + 1); continue; }
            i++;
          }
          continue;
        }
      }
      i++;
    }
    throw new ScanError(line, 'unbalanced braces in an f-string');
  };
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '{') {
      if (body[i + 1] === '{') { i += 2; continue; }
      i = scanField(i + 1);
      continue;
    }
    if (c === '}') { i += body[i + 1] === '}' ? 2 : 1; continue; }
    i++;
  }
  return out;
}

interface Scanned { tokens: Tok[]; subs: Tok[][] }

function tokenize(src: string, startLine: number, depth: number): Scanned {
  const tokens: Tok[] = [];
  const subs: Tok[][] = [];
  const stack: number[] = [];
  let i = 0;
  let line = startLine;
  const n = src.length;
  const push = (t: Tok) => { tokens.push(t); if (tokens.length > MAX_TOKENS) throw new ScanError(line, 'script too large to check'); };
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++;
      if (stack.length === 0 && tokens.length && tokens[tokens.length - 1]!.k !== 'nl') push({ k: 'nl', v: '\n', line });
      line++;
      continue;
    }
    if (c === '#') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; line++; continue; }
      if (src[i + 1] === '\r') { i += src[i + 2] === '\n' ? 3 : 2; line++; continue; }
      throw new ScanError(line, 'stray backslash');
    }
    // string with optional prefix
    const pm = /^([rRbBuUfF]{1,2})?("""|'''|"|')/.exec(src.slice(i, i + 5));
    if (pm && (pm[1] === undefined || /^(r|b|u|f|rb|br|fr|rf)$/i.test(pm[1]))) {
      const prefix = (pm[1] ?? '').toLowerCase();
      const quote = pm[2]!;
      const startLn = line;
      i += (pm[1]?.length ?? 0) + quote.length;
      const bodyStart = i;
      const raw = prefix.includes('r');
      const triple = quote.length === 3;
      let closed = false;
      while (i < n) {
        const d = src[i]!;
        if (d === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (d === '\n' || d === '\r') {
          if (!triple) throw new ScanError(startLn, 'unterminated string');
          if (d === '\r' && src[i + 1] === '\n') i++;
          line++; i++; continue;
        }
        if (src.startsWith(quote, i)) { closed = true; break; }
        i++;
      }
      if (!closed) throw new ScanError(startLn, 'unterminated string');
      const body = src.slice(bodyStart, i);
      i += quote.length;
      const isF = prefix.includes('f');
      const isBytes = prefix.includes('b');
      const value = isF || isBytes ? null : raw ? body : decodeEscapes(body);
      push({ k: 'str', v: src.slice(bodyStart - quote.length - prefix.length, i), line: startLn, value, isF, body });
      if (isF) {
        if (depth >= MAX_FSTRING_DEPTH) throw new ScanError(startLn, 'f-strings nested too deeply');
        for (const expr of fExpressions(body, startLn)) {
          const sub = tokenize(expr.trim() ? '(' + expr + '\n)' : '()', startLn, depth + 1);
          subs.push(sub.tokens, ...sub.subs);
        }
      }
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/.exec(src.slice(i, i + 80));
      const text = m ? m[0] : c;
      push({ k: 'num', v: text, line });
      i += text.length;
      continue;
    }
    if (NAME_START.test(c) || c.charCodeAt(0) > 127) {
      let j = i;
      // iterate by code point so astral identifier characters work
      for (const ch of src.slice(i, i + 200)) {
        if (j === i ? NAME_START.test(ch) : NAME_PART.test(ch)) j += ch.length; else break;
      }
      if (j === i) throw new ScanError(line, `character U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} is not valid in Python code`);
      push({ k: 'name', v: src.slice(i, j).normalize('NFKC'), line });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    let op: string | undefined;
    if (OPS3.includes(three)) op = three;
    else if (OPS2.includes(two)) op = two;
    else if (OPS1.includes(c)) op = c;
    if (!op) throw new ScanError(line, `character ${JSON.stringify(c)} is not valid in Python code`);
    if (OPEN.has(op)) {
      stack.push(tokens.length);
      push({ k: 'op', v: op, line });
    } else if (CLOSE[op]) {
      const open = stack.pop();
      if (open === undefined || tokens[open]!.v !== CLOSE[op]) throw new ScanError(line, 'unbalanced brackets');
      tokens[open]!.pair = tokens.length;
      push({ k: 'op', v: op, line, pair: open });
    } else push({ k: 'op', v: op, line });
    i += op.length;
  }
  if (stack.length) throw new ScanError(tokens[stack[stack.length - 1]!]!.line, 'unbalanced brackets');
  return { tokens, subs };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------------------------------------------------------------

const looksWindows = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p);
function normPath(p: string, lower: boolean): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (lower) s = s.toLowerCase();
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Why a literal path is refused, or null when it is fine. */
export function pathProblem(value: string, allowedDirs: string[], live = false): string | null {
  if (value === '') return null;
  if (/[\0\r\n]/.test(value)) return 'the path holds control characters';
  if (value.startsWith('\\\\')) return 'network (UNC) paths are not allowed';
  if (/%[A-Za-z_]+%|\$\{?[A-Za-z_]|~/.test(value)) return 'environment variables and ~ are not expanded by the check, so they are refused';
  const segs = value.split(/[\\/]+/);
  if (segs.includes('..')) return 'a ".." segment could leave the allowed folder';
  // Blender-relative: "//" followed by a path, next to the .blend (in live Blender that is the user's own project folder)
  if (value.startsWith('//') && live) return 'a "//" path is next to the open .blend in the user\'s own folders; write into the export folder with LEGION_EXPORT_DIR + "/name"';
  if (value.startsWith('//')) return value.length > 2 && /^\/\/[^\\/]/.test(value) ? (/:/.test(value) ? 'a drive or scheme inside a relative path' : null) : 'an empty relative path';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return 'URLs are not file paths here';
  const absolute = value.startsWith('/') || value.startsWith('\\') || looksWindows(value);
  if (!absolute) return 'a relative path depends on an unknown folder; use "//name" (next to the .blend) or LEGION_EXPORT_DIR + "/name"';
  const win = looksWindows(value) || allowedDirs.some(looksWindows);
  const v = normPath(value, win);
  for (const d of allowedDirs) {
    const nd = normPath(d, win);
    if (v === nd || v.startsWith(nd + '/')) return null;
  }
  return `the path is outside the allowed folder${allowedDirs.length > 1 ? 's' : ''} (${allowedDirs.join(', ') || 'none configured'})`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------------------------

interface Ctx {
  opts: CheckOptions;
  lines: string[];
  findings: Finding[];
  notes: Set<string>;
  seen: Set<string>;
}

function block(ctx: Ctx, rule: string, line: number, detail: string): void {
  const key = `${rule}:${line}:${detail}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  const raw = ctx.lines[line - 1];
  ctx.findings.push({ rule, line, detail, ...(raw !== undefined ? { snippet: raw.trim().slice(0, 140) } : {}) });
}

const isOp = (t: Tok | undefined, v: string): boolean => !!t && t.k === 'op' && t.v === v;
const isName = (t: Tok | undefined, v?: string): boolean => !!t && t.k === 'name' && (v === undefined || t.v === v);

/** Merges implicit concatenation ("a" "b") of plain strings starting at i. Returns the literal and the index after it, or null when not a plain literal. */
function literalAt(t: Tok[], i: number, end: number): { value: string; next: number } | null {
  let value = '';
  let j = i;
  let any = false;
  while (j < end && t[j]!.k === 'str') {
    const s = t[j]!;
    if (s.value === null || s.value === undefined) return null;
    value += s.value;
    any = true;
    j++;
  }
  return any ? { value, next: j } : null;
}

/** End index (exclusive) of the value that starts at `from`: stops at a top-level comma, closing bracket, newline or semicolon. */
function valueEnd(t: Tok[], from: number): number {
  let j = from;
  while (j < t.length) {
    const x = t[j]!;
    if (x.k === 'nl' || isOp(x, ',') || isOp(x, ';') || (x.k === 'op' && CLOSE[x.v])) return j;
    if (x.k === 'op' && OPEN.has(x.v) && x.pair !== undefined) { j = x.pair + 1; continue; }
    j++;
  }
  return j;
}

type PathVerdict = { ok: true; desc?: string } | { ok: false; why: string };
/** Is t[from..end) an allowed path expression? */
function pathExpr(ctx: Ctx, t: Tok[], from: number, end: number): PathVerdict {
  if (from >= end) return { ok: false, why: 'the path argument is empty' };
  const lit = literalAt(t, from, end);
  if (lit && lit.next === end) {
    const why = pathProblem(lit.value, ctx.opts.allowedDirs, ctx.opts.live === true);
    return why ? { ok: false, why } : { ok: true, desc: lit.value };
  }
  if (isName(t[from], EXPORT_DIR_VAR)) {
    if (from + 1 === end) return { ok: true, desc: EXPORT_DIR_VAR };
    if (isOp(t[from + 1], '+')) {
      const rest = literalAt(t, from + 2, end);
      if (rest && rest.next === end) {
        if (!/^[\\/]/.test(rest.value)) return { ok: false, why: `${EXPORT_DIR_VAR} + "..." must continue with a "/" so the file stays inside the folder` };
        if (rest.value.split(/[\\/]+/).includes('..') || /[:\0\r\n]/.test(rest.value) || rest.value.startsWith('//') || rest.value.startsWith('\\\\')) return { ok: false, why: 'the file name part may not hold "..", ":" or a second root' };
        return { ok: true, desc: `${EXPORT_DIR_VAR}${rest.value}` };
      }
    }
  }
  return { ok: false, why: 'the path must be a plain string literal inside the allowed folder (not a variable, a joined, formatted or computed string), or ' + EXPORT_DIR_VAR + ' + "/name"' };
}

/** `files=[...]`: only simple file names, no folders. */
function filesValueProblem(t: Tok[], from: number, end: number): string | null {
  for (let j = from; j < end; j++) {
    const x = t[j]!;
    if (x.k === 'op' && ('[](){},:'.includes(x.v))) continue;
    if (x.k === 'str' && typeof x.value === 'string') {
      if (/[\\/:]|\.\./.test(x.value)) return 'file names in files=[...] may not hold folders, ":" or ".."';
      continue;
    }
    return 'files=[...] may only hold plain file-name literals';
  }
  return null;
}

function checkAttrName(ctx: Ctx, name: string, line: number, exemptBanned: boolean, called = true): void {
  if (name.startsWith('__') && name.endsWith('__') && name.length > 4) {
    if (!ATTR_DUNDER_OK.has(name)) block(ctx, 'dunder-attribute', line, `"${name}" gives access to Python internals`);
    return;
  }
  if (name.startsWith('_')) { block(ctx, 'private-attribute', line, `"${name}" is a private attribute (modules reach os and sys through names like this)`); return; }
  if (exemptBanned) return;
  if (CALL_ONLY_ATTRS.has(name)) { if (called) block(ctx, 'banned-attribute', line, `".${name}(...)" starts a process`); return; }
  if (BANNED_ATTRS.has(name)) block(ctx, 'banned-attribute', line, `".${name}" is not allowed (process, file, network, import, string-evaluating or persistent feature)`);
}

function checkImports(ctx: Ctx, t: Tok[]): void {
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    if (x.k !== 'name' || isOp(t[i - 1], '.')) continue;
    if (x.v !== 'import' && x.v !== 'from') continue;
    const prev = t[i - 1];
    if (prev && !(prev.k === 'nl' || isOp(prev, ';') || isOp(prev, ':'))) continue; // `raise X from e`, `yield from y`
    const modsOk = (dotted: string[], line: number): void => {
      const root = dotted[0] ?? '';
      if (!ALLOWED_MODULES.has(root)) block(ctx, 'import', line, `import of "${dotted.join('.')}" is not allowed (allowed: ${[...ALLOWED_MODULES].filter((m) => m !== '__future__').join(', ')})`);
      for (const seg of dotted.slice(1)) {
        if (seg === 'ops') block(ctx, 'import', line, 'import bpy.ops directly is not allowed; call bpy.ops.<group>.<operator>(...)');
        else if (seg.startsWith('_') || BANNED_ATTRS.has(seg)) block(ctx, 'import', line, `import path segment "${seg}" is not allowed`);
      }
    };
    const readDotted = (j: number): { names: string[]; next: number } => {
      const names: string[] = [];
      while (isName(t[j])) {
        names.push(t[j]!.v);
        j++;
        if (isOp(t[j], '.') && isName(t[j + 1])) j++; else break;
      }
      return { names, next: j };
    };
    if (x.v === 'import') {
      let j = i + 1;
      for (;;) {
        const d = readDotted(j);
        if (!d.names.length) { block(ctx, 'import', x.line, 'could not read this import'); break; }
        modsOk(d.names, x.line);
        j = d.next;
        if (isName(t[j], 'as') && isName(t[j + 1])) j += 2;
        if (isOp(t[j], ',')) { j++; continue; }
        break;
      }
    } else {
      let j = i + 1;
      if (isOp(t[j], '.') || isOp(t[j], '...')) { block(ctx, 'import', x.line, 'relative imports are not allowed'); continue; }
      const d = readDotted(j);
      if (!d.names.length) { block(ctx, 'import', x.line, 'could not read this import'); continue; }
      modsOk(d.names, x.line);
      j = d.next;
      if (!isName(t[j], 'import')) { block(ctx, 'import', x.line, 'could not read this import'); continue; }
      // private names (from random import _os) are how stdlib modules hold os and sys
      for (let k = j + 1; k < t.length && t[k]!.k !== 'nl' && !isOp(t[k], ';'); k++) {
        if (isName(t[k]) && t[k]!.v.startsWith('_') && !isName(t[k - 1], 'as')) block(ctx, 'import', x.line, `importing the private name "${t[k]!.v}" is not allowed`);
      }
      // imported names are ordinary name tokens and meet the bare-name rules below; "ops" must not be imported
      if (d.names[0] === 'bpy' || d.names.join('.').startsWith('bpy')) {
        for (let k = j + 1; k < t.length && t[k]!.k !== 'nl' && !isOp(t[k], ';'); k++) if (isName(t[k], 'ops')) block(ctx, 'import', x.line, 'importing bpy.ops by name is not allowed; call bpy.ops.<group>.<operator>(...)');
      }
    }
  }
}

/** One linear pass: the innermost open bracket around each token (-1 at top level) and the bracket depth. Keeps every later rule O(1) per token. */
function bracketMaps(t: Tok[]): { openOf: Int32Array; depthOf: Int32Array } {
  const openOf = new Int32Array(t.length);
  const depthOf = new Int32Array(t.length);
  const stack: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    if (x.k === 'op' && CLOSE[x.v]) stack.pop();
    openOf[i] = stack.length ? stack[stack.length - 1]! : -1;
    depthOf[i] = stack.length;
    if (x.k === 'op' && OPEN.has(x.v)) stack.push(i);
  }
  return { openOf, depthOf };
}

function analyzeStream(ctx: Ctx, t: Tok[]): void {
  const { openOf, depthOf } = bracketMaps(t);
  const exempt = new Set<number>();
  // mark def / lambda parameter lists
  for (let i = 0; i < t.length; i++) {
    if (isName(t[i], 'def') && isName(t[i + 1]) && isOp(t[i + 2], '(')) t[i + 2]!.defParen = true;
    if (isName(t[i], 'lambda')) {
      // lambda params end at the colon; ** inside is a parameter, not an unpack
      for (let j = i + 1; j < t.length && !isOp(t[j], ':') && t[j]!.k !== 'nl'; j++) exempt.add(j);
    }
  }
  checkImports(ctx, t);

  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    const afterDot = isOp(t[i - 1], '.');

    if (x.k === 'str') {
      if (typeof x.value === 'string') {
        if (/\.\s*__[A-Za-z]/.test(x.value) || /\{[^{}]*\.\s*_/.test(x.value)) block(ctx, 'dunder-string', x.line, 'a string that spells a dunder or private attribute path can be walked by str.format or string.Formatter');
      }
      continue;
    }
    if (x.k === 'op') {
      // keyword unpacking hides arguments from the path and ops checks
      if (x.v === '**' && (isOp(t[i - 1], '(') || isOp(t[i - 1], ',')) && !exempt.has(i)) {
        const open = openOf[i]!;
        if (open >= 0 && t[open]!.v === '(' && !t[open]!.defParen) block(ctx, 'keyword-unpacking', x.line, '**mapping in a call hides arguments from the check; pass the arguments explicitly');
      }
      continue;
    }
    if (x.k !== 'name') continue;
    const name = x.v;
    const always = ALWAYS_BANNED_NAMES[name];
    if (always) block(ctx, always.rule, x.line, `"${name}" is not allowed: ${always.detail}`);

    // ---- bpy.ops chains -------------------------------------------------------------------------------------------------
    if (name === 'ops' && (afterDot || isOp(t[i + 1], '.'))) {
      if (isOp(t[i + 1], '.') && isName(t[i + 2]) && isOp(t[i + 3], '.') && isName(t[i + 4])) {
        const ns = t[i + 2]!.v;
        const op = t[i + 4]!.v;
        const key = `${ns}.${op}`;
        if (ns.startsWith('_') || op.startsWith('_')) block(ctx, 'private-attribute', x.line, 'private operator names are not allowed');
        if (DENIED_OPS_NS.has(ns)) block(ctx, 'ops-namespace', x.line, `bpy.ops.${ns}.* is not allowed (it runs scripts, changes preferences, installs code or handles files outside the path check)`);
        else if (!ALLOWED_OPS_NS.has(ns)) block(ctx, 'ops-namespace', x.line, `bpy.ops.${ns}.* is not on the allowlist (modelling, material, scene data, image, render-to-file and import/export operators only; add-on operators are refused)`);
        else if (OPS_SUBLIST[ns] && !OPS_SUBLIST[ns]!.has(op)) {
          if (ns === 'wm') block(ctx, 'ops-wm', x.line, `bpy.ops.wm.${op} is not allowed (only ${[...WM_ALLOWED].slice(0, 5).join(', ')} and the import/export operators are)`);
          else block(ctx, 'ops-denied', x.line, `bpy.ops.${key} is not allowed (only ${[...OPS_SUBLIST[ns]!].join(', ')} are)`);
        }
        if (DENIED_OPS.has(key)) block(ctx, 'ops-denied', x.line, `bpy.ops.${key} is not allowed (it starts another program, resets the user's settings or shows an external window)`);
        if (/driver/.test(op)) block(ctx, 'ops-driver', x.line, `bpy.ops.${key}: drivers can hold Python expressions the check cannot read`);
        if (ctx.opts.live && LIVE_BLEND_LOAD.has(key)) block(ctx, 'ops-blend-load', x.line, `bpy.ops.${key} is refused in live Blender: a .blend file can carry runnable code (text modules, drivers, handlers), and files in the export folder are not trusted`);
        if (key === 'wm.save_as_mainfile') {
          const open = t[i + 5];
          let hasCopy = false;
          if (isOp(open, '(') && open!.pair !== undefined) {
            for (let j = i + 6; j < open!.pair!; j++) {
              if (depthOf[j] === depthOf[i + 5]! + 1 && isName(t[j], 'copy') && isOp(t[j + 1], '=') && isName(t[j + 2], 'True') && (isOp(t[j + 3], ',') || j + 3 === open!.pair)) hasCopy = true;
            }
          }
          if (!hasCopy) block(ctx, 'ops-save-copy', x.line, 'bpy.ops.wm.save_as_mainfile must be called with copy=True (without it the open scene is renamed to the new file)');
        }
        if (OPS_REPLACES_SCENE.has(key)) ctx.notes.add(`replaces the open scene (bpy.ops.${key}); the backup is the way back`);
        if (ns === 'wm' && (op === 'save_mainfile' || op === 'save_as_mainfile')) ctx.notes.add('saves the .blend file (a .blend can carry runnable code: do not open it with auto-run scripts on)');
        if (ns === 'object' && /delete/.test(op)) ctx.notes.add('deletes objects');
        if (ns === 'outliner' && /delete|orphans_purge/.test(op)) ctx.notes.add('deletes data');
        if (OPS_BANNED_OK.has(key)) exempt.add(i + 4);
      } else {
        block(ctx, 'ops-alias', x.line, '"ops" must be used as bpy.ops.<group>.<operator>(...); aliasing it, passing it on or looking its members up by name hides what runs');
      }
    }

    // ---- names ---------------------------------------------------------------------------------------------------------
    if (afterDot) {
      if (name === 'format' || name === 'format_map') { /* literal content is scanned above */ }
      checkAttrName(ctx, name, x.line, exempt.has(i), isOp(t[i + 1], '('));
      // method calls whose first argument is a path
      if (SINK_CALLS.has(name) && isOp(t[i + 1], '(') && t[i + 1]!.pair !== undefined) {
        const close = t[i + 1]!.pair!;
        if (close > i + 2) {
          // first positional argument unless it is keyword=
          const firstEnd = valueEnd(t, i + 2);
          const kw = isName(t[i + 2]) && isOp(t[i + 3], '=');
          const star = isOp(t[i + 2], '*') || isOp(t[i + 2], '**');
          if (star) block(ctx, 'path-unpacking', x.line, `.${name}(*args) hides the path argument from the check`);
          else if (!kw) {
            const v = pathExpr(ctx, t, i + 2, firstEnd);
            if (!v.ok) block(ctx, 'path', x.line, `.${name}(...): ${v.why}`);
            else if (v.desc) ctx.notes.add(`${name === 'load' ? 'reads' : 'writes'} ${v.desc}`);
          }
        }
      }
      // sequencer strips: new_movie(name, filepath, ...) carries the path in the second positional argument
      if (SINK_CALLS_ARG2.has(name) && isOp(t[i + 1], '(') && t[i + 1]!.pair !== undefined) {
        const close = t[i + 1]!.pair!;
        let c = -1;
        for (let j = i + 2; j < close; j = isOp(t[j], '(') || isOp(t[j], '[') || isOp(t[j], '{') ? t[j]!.pair! + 1 : j + 1) { if (isOp(t[j], ',')) { c = j; break; } }
        if (c > 0 && !(isName(t[c + 1]) && isOp(t[c + 2], '='))) {
          const v = pathExpr(ctx, t, c + 1, valueEnd(t, c + 1));
          if (!v.ok) block(ctx, 'path', x.line, `.${name}(...): ${v.why}`);
        } else if (c < 0 || (isName(t[c + 1]) && isOp(t[c + 2], '='))) {
          // the path may be given as filepath=..., which the keyword rule reads; a missing one is the call's own error
        }
      }
    } else {
      if (name.startsWith('__') && name.endsWith('__') && name.length > 4) {
        if (!BARE_DUNDER_OK.has(name)) block(ctx, 'dunder-name', x.line, `"${name}" gives access to Python internals`);
      } else if (BANNED_BARE.has(name) && !isKeywordArgName(t, i)) {
        block(ctx, 'banned-name', x.line, `"${name}" is not allowed (process, file, network, import or code-evaluating facility)`);
      } else if (BANNED_BARE.has(name)) {
        // a keyword argument that happens to share a banned name (open=True): harmless by itself
      }
      if (name === 'getattr' || name === 'setattr' || name === 'hasattr' || name === 'delattr') {
        if (!isOp(t[i + 1], '(') || t[i + 1]!.pair === undefined) block(ctx, 'getattr', x.line, `${name} may only be called directly, not passed around`);
        else {
          const open = i + 1;
          const argStart = (() => { let j = open + 1; const e = t[open]!.pair!; while (j < e) { if (isOp(t[j], ',')) return j + 1; if (t[j]!.k === 'op' && OPEN.has(t[j]!.v) && t[j]!.pair !== undefined) j = t[j]!.pair! + 1; else j++; } return -1; })();
          const lit = argStart >= 0 ? literalAt(t, argStart, t[open]!.pair!) : null;
          const after = lit ? t[lit.next] : undefined;
          if (!lit || !(after === undefined || isOp(after, ',') || isOp(after, ')'))) block(ctx, 'getattr', x.line, `${name}(obj, name): the name must be a plain string literal, so the check can read it`);
          else {
            const before = ctx.findings.length;
            if (lit.value === 'ops') block(ctx, 'getattr', x.line, 'looking up "ops" by name would hide bpy.ops from the check');
            if (isPathName(lit.value)) block(ctx, 'getattr', x.line, `${name}(obj, "${lit.value}"): path-carrying attributes can only be set with a plain obj.${lit.value} = "<literal path>" so the path check can read the value`);
            checkAttrName(ctx, lit.value, x.line, false);
            if (ctx.findings.length > before) ctx.findings[ctx.findings.length - 1]!.rule = 'getattr';
          }
        }
      }
    }

    // ---- path sinks: keyword arguments (attribute assignments are read by checkAssignments below) --------------------------
    const isKw = isKeywordArgName(t, i) && isCallParen(t, openOf, i);
    if (isKw && name !== 'files' && (SINK_KWARG_OLD.has(name) || isPathName(name))) {
      const end = valueEnd(t, i + 2);
      const v = isHarmlessScalar(t, i + 2, end) ? ({ ok: true } as PathVerdict) : pathExpr(ctx, t, i + 2, end);
      if (!v.ok) block(ctx, 'path', x.line, `${name}=: ${v.why}`);
      else if (v.desc) ctx.notes.add(`writes or reads ${v.desc}`);
    }
    if (name === 'files' && isKw) {
      const why = filesValueProblem(t, i + 2, valueEnd(t, i + 2));
      if (why) block(ctx, 'path', x.line, why);
    }
    if (name === 'while' && !afterDot) ctx.notes.add('contains a while loop (Blender stays busy until it ends)');
  }
  checkAssignments(ctx, t, depthOf);
}

/** A value that cannot be a path: one number, True, False or None (curve.path_duration = 100, relative_path=True). */
function isHarmlessScalar(t: Tok[], from: number, end: number): boolean {
  let j = from;
  if (isOp(t[j], '-') || isOp(t[j], '+')) j++;
  return end - j === 1 && j < end && (t[j]!.k === 'num' || (isName(t[j]) && (t[j]!.v === 'True' || t[j]!.v === 'False' || t[j]!.v === 'None')));
}

const HEADER_KW = new Set(['if', 'elif', 'else', 'while', 'for', 'with', 'try', 'except', 'finally', 'def', 'class', 'async']);
const AUG_OPS = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '^=', '|=', '@=']);
const LOOKAHEAD_CAP = 200;

/**
 * Every way Python assigns to an attribute: `a.b = v`, `a.b = c.d = v`, `a.b, c = ...`, `[a.b] = ...`, `for a.b in ...`, `with x as a.b`,
 * `a.b += v`, annotated `a.b: T = v`. A plain target is checked like a path keyword (the value must be a literal inside the allowed folders);
 * a tuple, loop, with or augmented target that names a path attribute is refused, because the value cannot be read.
 */
function checkAssignments(ctx: Ctx, t: Tok[], depthOf: Int32Array): void {
  const pathHits = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let j = Math.max(from, 0); j < to && j < t.length; j++) if (t[j]!.k === 'name' && isOp(t[j - 1], '.') && isPathName(t[j]!.v)) out.push(j);
    return out;
  };
  const refuse = (idx: number, why: string): void => block(ctx, 'path', t[idx]!.line, `.${t[idx]!.v}: ${why}`);
  /** [from,to) is a plain chain of names, .attr, [..] and (..) with nothing else around it. Returns the last name token when the chain ENDS in an attribute. */
  const chainEnd = (from: number, to: number): { simple: boolean; attr: number } => {
    let j = from;
    if (!isName(t[j])) return { simple: false, attr: -1 };
    let attr = -1;
    j++;
    while (j < to) {
      if (isOp(t[j], '.') && isName(t[j + 1]) && j + 1 < to) { attr = j + 1; j += 2; continue; }
      if ((isOp(t[j], '[') || isOp(t[j], '(')) && t[j]!.pair !== undefined) { j = t[j]!.pair! + 1; attr = -1; continue; }
      return { simple: false, attr: -1 };
    }
    return { simple: j === to, attr };
  };
  const checkTarget = (from: number, to: number, value: [number, number] | null): void => {
    const hits = pathHits(from, to);
    if (!hits.length) return;
    const ch = chainEnd(from, to);
    if (ch.simple) {
      if (ch.attr < 0 || !hits.includes(ch.attr)) return; // a subscript or a call on a path-ish name, or a path-ish name in the middle of the chain
      if (!value) { refuse(ch.attr, 'an augmented assignment to a path attribute cannot be read; assign a plain literal path instead'); return; }
      if (isHarmlessScalar(t, value[0], value[1])) return;
      const v = pathExpr(ctx, t, value[0], value[1]);
      if (!v.ok) block(ctx, 'path', t[ch.attr]!.line, `${t[ch.attr]!.v}=: ${v.why}`);
      else if (v.desc) ctx.notes.add(`writes or reads ${v.desc}`);
      return;
    }
    refuse(hits[0]!, 'a path attribute assigned through a tuple, list, starred, loop or with target cannot be read; assign it with a plain `obj.attr = "<literal path>"` statement');
  };

  // simple statements (a compound header is cut at its colon; the rest is a statement of its own)
  const work: Array<[number, number]> = [];
  let s0 = 0;
  for (let i = 0; i <= t.length; i++) {
    if (i === t.length || t[i]!.k === 'nl' || (isOp(t[i], ';') && depthOf[i] === 0)) { if (i > s0) work.push([s0, i]); s0 = i + 1; }
  }
  while (work.length) {
    let [a, b] = work.pop()!;
    if (a >= b) continue;
    if (isName(t[a]) && HEADER_KW.has(t[a]!.v)) {
      let c = -1;
      for (let j = a + 1; j < b; j++) if (isOp(t[j], ':') && depthOf[j] === 0) { c = j; break; }
      if (c < 0) continue;
      a = c + 1;
      if (a >= b) continue;
    }
    const eqs: number[] = [];
    let aug = -1;
    let ann = -1;
    let sawLambda = false;
    for (let j = a; j < b; j++) {
      if (depthOf[j] !== 0) continue;
      const x = t[j]!;
      if (isName(x, 'lambda')) sawLambda = true;
      if (isOp(x, '=')) eqs.push(j);
      else if (x.k === 'op' && AUG_OPS.has(x.v) && aug < 0) aug = j;
      else if (isOp(x, ':') && ann < 0 && !sawLambda && eqs.length === 0) ann = j;
    }
    if (aug >= 0 && eqs.length === 0) { checkTarget(a, aug, null); continue; }
    if (ann >= 0) {
      const eq = eqs.find((e) => e > ann);
      checkTarget(a, ann, eq !== undefined ? [eq + 1, b] : null);
      if (eq === undefined) continue;
    }
    if (eqs.length && ann < 0) {
      const value: [number, number] = [eqs[eqs.length - 1]! + 1, b];
      let from = a;
      for (const e of eqs) { checkTarget(from, e, value); from = e + 1; }
    }
  }
  // loop and with targets, wherever they appear (statement or comprehension)
  for (let i = 0; i < t.length; i++) {
    if ((isName(t[i], 'for') || isName(t[i], 'as')) && !isOp(t[i - 1], '.')) {
      const d = depthOf[i]!;
      let end = -1;
      for (let j = i + 1; j < t.length && j < i + LOOKAHEAD_CAP; j++) {
        if (t[j]!.k === 'nl' || depthOf[j]! < d) { end = j; break; }
        if (depthOf[j] === d && (isName(t[j], 'in') && t[i]!.v === 'for' || (t[i]!.v === 'as' && (isOp(t[j], ',') || isOp(t[j], ':'))))) { end = j; break; }
      }
      if (end < 0) end = Math.min(t.length, i + LOOKAHEAD_CAP);
      const hits = pathHits(i + 1, end);
      if (hits.length) refuse(hits[0]!, `a path attribute used as a ${t[i]!.v === 'for' ? 'loop' : 'with'} target cannot be read; assign it with a plain \`obj.attr = "<literal path>"\` statement`);
    }
  }
}

/** True when the name token at i looks like `name=` right after `(` or `,`. */
function isKeywordArgName(t: Tok[], i: number): boolean {
  return isOp(t[i + 1], '=') && (isOp(t[i - 1], '(') || isOp(t[i - 1], ','));
}
/** True when the innermost bracket around token i is a call's parenthesis (not a def parameter list, tuple, list or dict). Uses the precomputed bracket map: O(1). */
function isCallParen(t: Tok[], openOf: Int32Array, i: number): boolean {
  const o = openOf[i]!;
  if (o < 0) return false;
  const y = t[o]!;
  if (y.v !== '(' || y.defParen) return false;
  const p = t[o - 1];
  return !!p && (p.k === 'name' || isOp(p, ')') || isOp(p, ']'));
}

/** Bidirectional overrides, embeddings and isolates (U+202A-202E, U+2066-2069): refused. */
export const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/g;
/** Zero-width, joiner, word-joiner, BOM, soft hyphen, bidi marks, line and paragraph separators, NEL: flagged. */
export const INVISIBLE_CHARS = /[\u00ad\u061c\u0085\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g;

function codingCookie(src: string): string | null {
  const first = src.split(/\r\n|\r|\n/, 2);
  for (const l of first) {
    const m = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

export function checkScript(source: string, opts: CheckOptions): CheckResult {
  const lines = source.split(/\r\n|\r|\n/);
  const bytes = Buffer.byteLength(source, 'utf8');
  const ctx: Ctx = { opts, lines, findings: [], notes: new Set(), seen: new Set() };
  const done = (): CheckResult => ({ ok: ctx.findings.length === 0, findings: ctx.findings, notes: [...ctx.notes], lines: lines.length, bytes });
  if (!source.trim()) { block(ctx, 'empty', 1, 'the script is empty'); return done(); }
  if (bytes > MAX_SCRIPT_BYTES) { block(ctx, 'size', 1, `the script is ${bytes} bytes; the limit is ${MAX_SCRIPT_BYTES}. Split it into smaller scripts`); return done(); }
  if (source.includes('\0')) { block(ctx, 'control', 1, 'the script holds a NUL character'); return done(); }
  const cookie = codingCookie(source);
  if (cookie && !/^utf-?8$/i.test(cookie)) { block(ctx, 'encoding', 1, `source encoding "${cookie}" is not allowed (UTF-8 only)`); return done(); }
  // Characters that make the text on a screen differ from the text Python reads (Trojan Source): bidirectional overrides and isolates are refused
  // wherever they are (comments and strings too); other invisible characters are allowed but flagged on the approval card.
  const lineAt = (idx: number): number => { let n = 1; const re = /\r\n|\r|\n/g; const head = source.slice(0, idx); while (re.exec(head)) n++; return n; };
  for (const m of source.matchAll(BIDI_CONTROL)) {
    block(ctx, 'hidden-characters', lineAt(m.index ?? 0), `the script holds the bidirectional control character U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}; it can make the code on screen read differently from the code Python runs`);
    if (ctx.findings.length >= 6) break;
  }
  if (ctx.findings.length) return done();
  const invisible = source.match(INVISIBLE_CHARS);
  if (invisible) ctx.notes.add(`holds ${invisible.length} invisible or line-separator character${invisible.length === 1 ? '' : 's'} (${[...new Set(invisible.map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')))].slice(0, 4).join(', ')}); the card shows them as markers`);
  let scanned: Scanned;
  try { scanned = tokenize(source, 1, 0); } catch (e) {
    if (e instanceof ScanError) { block(ctx, 'syntax', e.line, `cannot check this script: ${e.message}`); return done(); }
    throw e;
  }
  analyzeStream(ctx, scanned.tokens);
  for (const sub of scanned.subs) analyzeStream(ctx, sub);
  return done();
}

/** One short text for the agent: what was refused and why. */
export function describeFindings(r: CheckResult): string {
  const rows = r.findings.slice(0, 12).map((f) => `- line ${f.line} [${f.rule}] ${f.detail}${f.snippet ? `\n    ${f.snippet}` : ''}`);
  const more = r.findings.length > 12 ? `\n- ... and ${r.findings.length - 12} more` : '';
  return `The script was not run: the safety check refused it.\n${rows.join('\n')}${more}\nNothing reached Blender and no approval was asked. Rewrite the script without these.`;
}
