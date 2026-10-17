/**
 * Which file paths hold secrets (gates PR 2): an agent that reads one of these may not then send anything out without asking.
 * Documented-shape files (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) and public keys (`id_rsa.pub`) are left alone.
 * Matches by name or path segment, with either slash, in any case. A path check only: nothing here opens a file.
 */
const NAMES = /(^|[\\/])(\.env(\.(?!(example|sample|template|dist)$)[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|id_(rsa|ed25519|ecdsa|dsa)(?!\.pub$)[\w.-]*|credentials|[^\\/]+\.(pem|key|p12|pfx))$/i;
/** Whole directories of credentials, and exact files inside a dot-directory. */
const DIRS = /(^|[\\/])\.(ssh|aws|gnupg)[\\/]|(^|[\\/])\.docker[\\/]config\.json$|(^|[\\/])\.kube[\\/]config$/i;

export const isSecretPath = (p: string): boolean => NAMES.test(p) || DIRS.test(p);

/** Programs whose later words are files they read, copy or send. A program not in this list is a known gap. */
const READERS: ReadonlySet<string> = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'select-string', 'sls', 'findstr', 'grep', 'rg', 'awk', 'sed', 'cp', 'copy', 'copy-item', 'xcopy', 'robocopy', 'base64', 'certutil', 'openssl', 'scp', 'curl', 'wget', 'strings', 'xxd', 'od', 'hexdump', 'sort', 'bat']);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'LS']);
const unquote = (s: string): string => s.replace(/^["'`]+|["'`]+$/g, '');

/** The first secret path a search names: a `*` or `?` is dropped, then replaced by `x`, and both forms are tested. Returns the value as written. */
function wildcardHit(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return isSecretPath(value.replace(/[*?]/g, '')) || isSecretPath(value.replace(/[*?]/g, 'x')) ? value : undefined;
}

function shellHit(command: string): string | undefined {
  for (const seg of command.split(/[;|&\n\r]+/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const first = unquote(words[0] ?? '').split(/[\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
    if (!READERS.has(first)) continue;
    for (const w of words.slice(1)) {
      const f = unquote(unquote(w).replace(/^--[\w-]+=/, '').replace(/^@/, ''));
      if (f && isSecretPath(f)) return f;
    }
  }
  return undefined;
}

/**
 * The secret file a tool call reads, or undefined. Read: `file_path`. Glob and LS: `path`, `glob`, `pattern`; Grep: `path` and `glob` (its
 * `pattern` is text to find, not a file, so a search for the word "credentials" is not a read). Shell tools: a reader program (see READERS) in
 * any `;`, `|`, `&` or newline segment, with a secret path among its later words. Gaps: a program not listed, `cat $X`, a renamed file, and a
 * search over a folder that does not name the file.
 */
export function secretReadHit(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'Read') { const p = input.file_path; return typeof p === 'string' && isSecretPath(p) ? p : undefined; }
  if (SEARCH_TOOLS.has(toolName)) {
    for (const k of toolName === 'Grep' ? ['path', 'glob'] : ['path', 'glob', 'pattern']) { const h = wildcardHit(input[k]); if (h) return h; }
    return undefined;
  }
  if ((toolName === 'Bash' || toolName === 'PowerShell' || toolName === 'Monitor' || toolName.startsWith('mcp__host__')) && typeof input.command === 'string') return shellHit(input.command);
  return undefined;
}
