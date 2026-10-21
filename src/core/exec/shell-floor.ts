/**
 * The safety floor for every shell command an agent runs (Legion's host shell, Claude Code's Bash and PowerShell, Monitor).
 *
 * Two questions, answered by reading the command text:
 *  - refuseCatastrophic: would it destroy a whole drive, a system folder or a home folder, or run hidden (decoded or
 *    encoded) text? Then it is refused for every agent, in every approval mode. A full-access tier forgives the approval
 *    card, not the machine (the Wipe Lesson).
 *  - unjudgeableCommand: can the text be judged at all? A command whose program is only known when it runs, that runs
 *    another command's output as a script, or that deletes a folder named only by a variable could be anything, so it
 *    gets the owner's approval card in every approval mode. Fail closed: what cannot be read is asked about.
 *
 * Design (two adversarial reviews, 2026-10-13): the refusal looks for a delete verb ANYWHERE among a segment's unquoted
 * words with a protected target after it, not only at the start of a command. The shell offers endless ways to put
 * something else first (subshells, groups, assignments, wrappers with options, script blocks); a verb anywhere closes
 * them as one family. Text in quotes on a line that runs no text is data (a commit message, a grep pattern), as before.
 * The card rules follow the shell the tool runs: PowerShell, POSIX sh, or cmd (with bash -c and powershell -c inside).
 *
 * Known limits, stated rather than hidden: a script written to a file and then run, `python -c` or `node -e` calling a
 * delete, a target that arrives on stdin (`echo /c | xargs rm -rf`), and relative deletes from an unknown folder are not
 * seen by reading. Neither are folders below the protected ones (C:\Windows\System32\config, ~/.ssh), single system
 * files, overwrites (`> /etc/passwd`) and the registry. Only a sandboxed backend closes those; the next step is a card
 * for any delete whose target is not provably ordinary (council 2026-10-13, measured on 20,205 real agent commands).
 * The project-folder rule (criticalDelete, below) is default deny: a delete that could reach the project folder or a folder
 * above it is asked about, and it trusts only a narrow proof (plain words, one plain cd at the start of the line). Its stated
 * limits: git's clean command, `node -e` / `python -c` / a script file, `xargs` and stdin in sh, 8.3 short names of the
 * project path, symlinks, junctions and drive aliases made before the line, Git Bash mounts other than the drives, a CDPATH
 * set before the run, and no OS sandbox.
 */

export type ShellKind = 'sh' | 'pwsh' | 'cmd';

/** Longer than this, a command is not read: it gets a card (Claude Code prompts for commands over 10,000 characters too). */
export const MAX_READABLE = 10_000;

/* ---------- reading a command ---------- */

/**
 * A line continuation joins two lines into one command, each shell with its own character: sh's backslash, PowerShell's
 * backtick, cmd's caret. Only that shell's: in PowerShell a path that ends in a backslash (`ls C:\`) ends its line.
 */
const joinLines = (cmd: string, shell: ShellKind): string => cmd.replace(shell === 'pwsh' ? /`\r?\n/g : shell === 'cmd' ? /\^\r?\n/g : /\\\r?\n/g, '');

/**
 * PowerShell text in the form the rest of the reading expects, without changing what it runs: curly quotes are quotes
 * to PowerShell (‘C:\’ is 'C:\'), a backtick before a letter or path character inside a word is dropped (Re`move-Item is
 * Remove-Item, C:`\ is C:\), a block comment <# … #> is blank space, and a call operator glued to what it calls (&$x,
 * &("a"+"b")) is read with a space, so the card rule for built programs sees it.
 */
function normalizePwsh(s: string): string {
  const t = withoutComments(s.replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c\u201d\u201e]/g, '"'), 'pwsh');
  return t.replace(/`(?=[\w\\/:.-])/g, '').replace(/(^|[^&\w])&(?=[($"'{])/g, '$1& ');
}

/** The text with every comment turned into blank space (line breaks kept): nothing in a comment runs. */
function withoutComments(s: string, shell: ShellKind): string {
  return shell === 'cmd' ? s : blankRanges(s, readLine(s, shell).blocks);
}

/** The text with each range (in order, not overlapping) turned into spaces, line breaks kept. One pass, however many ranges. */
function blankRanges(s: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (!ranges.length) return s;
  const parts: string[] = [];
  let at = 0;
  for (const [a, b] of ranges) { if (a < at) continue; parts.push(s.slice(at, a), s.slice(a, b).replace(/[^\n]/g, ' ')); at = b; }
  parts.push(s.slice(at));
  return parts.join('');
}

/**
 * The text a shell actually runs, joined and normalised for reading. bash (Git Bash included) and cmd drop every carriage
 * return before they read a line, even inside quotes: `r<CR>m -rf /c` runs rm. So the floor reads the line without them.
 */
const prepare = (cmd: string, shell: ShellKind): string => {
  const joined = joinLines(shell === 'pwsh' ? cmd : cmd.replace(/\r/g, ''), shell);
  return shell === 'pwsh' ? normalizePwsh(joined) : withoutComments(joined, shell);
};
/** cmd lets a switch touch its command (`rd/s/q`, `cmd/c`): read them apart. */
const unglue = (s: string): string => s.replace(/(^|[\s(@&|;])(rd|rmdir|del|erase|cmd|dir|start|call|robocopy|icacls|takeown|format|move|ren|rename)(?=\/)/gi, '$1$2 ');
/** ANSI-C quoting (`$'/'`) names the same text as a plain single quote, for the refusal (the card treats `$` as built). */
const ansiC = (s: string): string => s.replace(/\$'/g, "'");
/** A backslash-escaped space (`Program\ Files`) keeps a word together in sh: marked so the target check can read it. */
const ESCAPED_SPACE = '\u0001';

/** How a shell reads a line: the text with quoted strings, comments and heredoc bodies masked (same length), and what was left open. */
interface Reading { masked: string; open: boolean; heredocToRunner: boolean; blocks: Array<[number, number]>; literal: Array<[number, number]> }

/**
 * Reads a line the way `shell` does: what is inside quotes, a comment or a heredoc body is masked (same length), so a
 * separator or a quote there is not taken for one. sh: ' and " quotes, a backslash escapes the next character (inside
 * double quotes too), `#` starts a comment, `<<WORD` starts a heredoc body. PowerShell: ' and " (doubled inside to escape),
 * the backtick escapes, `#` comments, @'…'@ and @"…"@ here-strings. cmd: only " quotes, ^ escapes; a single quote is a
 * plain character there. `open` is true when a quote or here-string never closes: then the line cannot be read safely.
 */
function readLine(s: string, shell: ShellKind): Reading {
  // one command is read several times over (comments, substitutions, segments, runners): the same text is read once
  const hit = READS.find((r) => r[0] === shell && r[1] === s);
  if (hit) return hit[2];
  const reading = readLineOnce(s, shell);
  READS.unshift([shell, s, reading]);
  if (READS.length > 8) READS.pop();
  return reading;
}
/** The last few readings, newest first. Readings are never changed after they are made, so sharing them is safe. */
const READS: Array<[ShellKind, string, Reading]> = [];

function readLineOnce(s: string, shell: ShellKind): Reading {
  let out = '';
  let q: string | null = null;
  let heredocToRunner = false;
  let openComment = false;
  const heredocs: Array<{ end: string; quoted: boolean }> = [];
  const blocks: Array<[number, number]> = [];
  // text the shell never expands: single quotes, here-strings @'…'@, quoted heredoc bodies
  const literal: Array<[number, number]> = [];
  let litStart = -1;
  const atWordStart = (i: number) => i === 0 || /[\s;&|(]/.test(s[i - 1]!);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q === '@"' || q === "@'") {
      // a PowerShell here-string ends at a line that starts with "@ or '@
      if ((ch === '"' || ch === "'") && s[i + 1] === '@' && (i === 0 || s[i - 1] === '\n') && ch === q[1]) { if (q === "@'") literal.push([litStart, i + 2]); out += '__'; i++; q = null; continue; }
      out += '_';
      continue;
    }
    if (q) {
      if (shell === 'sh' && ch === '\\' && q === '"' && i + 1 < s.length) { out += '__'; i++; continue; }
      if (shell === 'pwsh' && ch === '`' && i + 1 < s.length) { out += '__'; i++; continue; }
      if (shell === 'pwsh' && ch === q && s[i + 1] === q) { out += '__'; i++; continue; }
      // a line break inside quotes is text, not the end of a command: masked like the rest
      if (ch === q) { if (q === "'") literal.push([litStart, i + 1]); q = null; out += ch; } else out += '_';
      continue;
    }
    // escapes outside quotes: sh's backslash, PowerShell's backtick, cmd's caret
    if ((shell === 'sh' && ch === '\\') || (shell === 'pwsh' && ch === '`') || (shell === 'cmd' && ch === '^')) {
      if (i + 1 < s.length && s[i + 1] !== '\n') { out += ch + '_'; i++; continue; }
    }
    if (shell === 'pwsh' && ch === '@' && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2))) { q = '@' + s[i + 1]; litStart = i; out += '__'; i++; continue; }
    if (ch === '"' || (ch === "'" && shell !== 'cmd')) { q = ch; litStart = i; out += ch; continue; }
    // sh arithmetic `(( … ))` and `$(( … ))`: its ; < > are arithmetic, not separators or redirects
    if (shell === 'sh' && ch === '(' && s[i + 1] === '(') {
      const end = s.indexOf('))', i + 2);
      if (end > 0) { out += '((' + '_'.repeat(end - i - 2) + '))'; i = end + 1; continue; }
    }
    // a PowerShell block comment runs to #>, across lines; the command after it on the same line runs. One never closed is unreadable.
    if (shell === 'pwsh' && ch === '<' && s[i + 1] === '#') {
      const end = s.indexOf('#>', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      if (end < 0) openComment = true;
      blocks.push([i, stop]);
      out += s.slice(i, stop).replace(/[^\n]/g, '_');
      i = stop - 1;
      continue;
    }
    // a comment runs to the end of the line: nothing in it is read
    if (ch === '#' && shell !== 'cmd' && atWordStart(i)) { const from = i; while (i < s.length && s[i] !== '\n') { out += '_'; i++; } blocks.push([from, i]); i--; continue; }
    // sh heredoc: `<<WORD`, `<<-WORD`, `<<'WORD'`: the body lines that follow are data (or a script, for a shell or interpreter)
    if (shell === 'sh' && ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      // the delimiter is a shell word: quotes and backslashes anywhere in it (E"O"F, \EOF) are removed, and quote the body
      const m = /^<<-?[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\])+)/.exec(s.slice(i));
      if (m) {
        heredocs.push({ end: m[1]!.replace(/['"\\]/g, ''), quoted: /['"\\]/.test(m[1]!) });
        const lineStart = s.lastIndexOf('\n', i) + 1;
        const nl = s.indexOf('\n', i);
        // the command the heredoc feeds: the words before it, and the pipe stages after it on its line (`cat <<EOF | sh`)
        const before = s.slice(lineStart, i).split(/[;&]/).pop() ?? '';
        const after = s.slice(i + m[0].length, nl < 0 ? s.length : nl).split(/[;&]/)[0] ?? '';
        const owners = `${before}${after}`.split('|').map((stage) => { const ws = words(stage); return commandPositions(ws).map((k) => program(clean(ws[k]!))); }).flat();
        // a heredoc into a SHELL is a script of commands nobody can read here; into python or node it is like their -c
        if (owners.some((p) => SHELLS.has(p))) heredocToRunner = true;
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === '\n' && heredocs.length) {
      // the heredoc's line, its body and its terminator are one command: no line break inside them separates commands
      out += '_';
      // mask each pending heredoc's body up to its terminator line
      let j = i + 1;
      while (heredocs.length) {
        const { end, quoted } = heredocs.shift()!;
        const bodyStart = j;
        for (;;) {
          if (j >= s.length) { i = s.length; break; }
          const nl = s.indexOf('\n', j);
          const line = s.slice(j, nl < 0 ? s.length : nl);
          const stop = line.trim() === end;
          if (quoted && (stop || nl < 0)) literal.push([bodyStart, stop ? j : s.length]);
          out += stop ? line : '_'.repeat(line.length);
          if (nl < 0) { j = s.length; break; }
          out += stop && !heredocs.length ? '\n' : '_';
          j = nl + 1;
          if (stop) break;
        }
      }
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return { masked: out.slice(0, s.length).padEnd(s.length, '_'), open: q !== null || openComment, heredocToRunner, blocks, literal };
}
/** The text with quoted strings (and comments and heredoc bodies) masked, for the default sh reading. */
const maskQuotes = (s: string, shell: ShellKind = 'sh'): string => readLine(s, shell).masked;

/**
 * The text of every command substitution the shell runs: `$( )` (sh and PowerShell), backticks (sh only: in PowerShell
 * a backtick is the escape), and sh's process substitution `<( )` / `>( )` at the start of a word outside quotes.
 * Single-quoted text, here-strings and quoted heredoc bodies are never expanded, so nothing in them runs. cmd has none.
 */
function substitutions(cmd: string, shell: ShellKind): string[] {
  if (shell === 'cmd') return [];
  const r = readLine(cmd, shell);
  // an escaped character is text: \$( and \` in sh, `$( in PowerShell
  const open = blankRanges(cmd, r.literal).replace(shell === 'pwsh' ? /`[\s\S]/g : /\\[\s\S]/g, '  ');
  const out: string[] = [];
  // each outermost $( … ) whole, nested ones and parentheses inside quotes or a heredoc included; its inner
  // substitutions and backticks are judged when its own text is (the caller recurses)
  const spans: Array<[number, number]> = [];
  const budget = { chars: 4 * cmd.length + 20_000 };
  for (let k = open.indexOf('$('); k >= 0;) {
    if (open[k + 2] === '(') { k = open.indexOf('$(', k + 3); continue; } // $(( … )) is arithmetic
    const end = closingParen(cmd, k + 2, shell, budget);
    out.push(cmd.slice(k + 2, end < 0 ? cmd.length : end));
    spans.push([k, end < 0 ? cmd.length : end + 1]);
    if (end < 0) break;
    k = open.indexOf('$(', end + 1);
  }
  if (shell === 'sh') for (const m of blankRanges(open, spans).matchAll(/`([^`]*)`/g)) out.push(m[1]!);
  if (shell === 'sh') {
    for (const m of r.masked.matchAll(/(?:^|[\s;&|(])[<>]\(/g)) {
      const inner = /^([^()]*)\)/.exec(cmd.slice(m.index! + m[0].length));
      if (inner) out.push(inner[1]!);
    }
  }
  return out;
}

/**
 * The index of the `)` that closes a group opened just before `from`, read the way the shell reads the text inside it
 * (quotes, comments and heredoc bodies hold no brackets). -1 when it never closes. Plain text takes a quick scan.
 */
function closingParen(s: string, from: number, shell: ShellKind, budget: { chars: number }): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (/['"`\\#<]/.test(ch)) {
      // quotes, escapes, a comment or a heredoc: read the rest properly. Bounded in total: past the budget the rest of
      // the line is taken as one substitution, which is read (and judged) as a whole by the caller
      budget.chars -= s.length - from;
      if (budget.chars < 0) return -1;
      const masked = readLine(s.slice(from), shell).masked;
      let d = 0;
      for (let j = 0; j < masked.length; j++) {
        if (masked[j] === '(') d++;
        else if (masked[j] === ')') { if (d === 0) return from + j; d--; }
      }
      return -1;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Splits at `re` where it matches OUTSIDE quotes, comments and heredocs, as the shell reads a line (`node -e "a; b"` is one command). */
function splitOutside(s: string, re: RegExp, shell: ShellKind = 'sh'): string[] {
  const masked = maskQuotes(s, shell);
  let g = GLOBAL.get(re);
  if (!g) { g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); GLOBAL.set(re, g); }
  const parts: string[] = [];
  let last = 0;
  for (const m of masked.matchAll(g)) { parts.push(s.slice(last, m.index)); last = m.index! + m[0].length; }
  parts.push(s.slice(last));
  return parts;
}
const PIPE = /\|/;
/** The global copy of each splitting pattern, made once (a long command is split thousands of times). */
const GLOBAL = new WeakMap<RegExp, RegExp>();

/**
 * A command line as words, the way a shell joins them: quoted and unquoted parts that touch are ONE word (`"r"m` is `rm`),
 * quotes keep spaces inside a word, and are then dropped; cmd's ^ escape is removed. Lower case.
 */
function words(segment: string): string[] {
  return (segment.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => undoubled(w.replace(/["'^]/g, '').toLowerCase())).filter(Boolean);
}

/**
 * Git Bash reads a word that starts with one slash as a path when it hands it to a Windows program, so a Windows switch
 * is written with two there: `cmd //c`, `robocopy //mir`, `rd //s`. Read as the switch it is. A word with a further
 * slash (`//server/share`) is a path and stays as written.
 */
const undoubled = (w: string): string => (/^\/\/[a-z?][\w:?.-]*$/.test(w) ? w.slice(1) : w);

/**
 * The program a word names: `/bin/rm` and `C:\Windows\System32\cmd.exe` are `rm` and `cmd`. A backslash in a word with
 * no drive or slash is sh's escape, not a folder separator: `r\m` runs `rm`.
 */
const program = (w: string): string => {
  let p = PROGRAMS.get(w);
  if (p !== undefined) return p;
  // a module-qualified cmdlet (Microsoft.PowerShell.Management\Remove-Item) is the cmdlet
  const qualified = /^[a-z][\w]*\.[\w.]+\\([a-z][\w-]*)$/.exec(w);
  p = qualified ? qualified[1]! : (/^[a-z]:|\//.test(w) ? w : w.replace(/\\/g, '')).replace(/^.*[\\/]/, '').replace(/\.(?:exe|com|cmd|bat)$/, '');
  if (PROGRAMS.size > 4096) PROGRAMS.clear();
  PROGRAMS.set(w, p);
  return p;
};
/** Words already read as programs: a long command repeats the same few words many times. */
const PROGRAMS = new Map<string, string>();

/**
 * A word as a verb or a target: no group or subshell brackets, no cmd `@`, no redirect glued on (`C:\>nul`). A closing
 * bracket is taken off only when the word did not open it (`${HOME}` keeps its brace, `(rd` and `C:\)` lose theirs).
 */
function clean(w: string): string {
  // PowerShell casts in front of an expression ([void](Remove-Item …)) are not the command either
  const s = w.replace(/^(?:\[[\w.]+\])+/, '').replace(/^[(@{]+/, '').replace(/(?<=.)\d?>{1,2}.*$/, '');
  if (!/[)};]$/.test(s)) return s;
  // counted once, then kept up to date while trailing closers come off: one pass, however many closers there are
  const count = { '(': 0, ')': 0, '{': 0, '}': 0 } as Record<string, number>;
  for (const ch of s) if (ch in count) count[ch]!++;
  let end = s.length;
  for (;;) {
    const last = s[end - 1];
    if (last === ';') { end--; continue; }
    const open = last === ')' ? '(' : last === '}' ? '{' : undefined;
    if (!open || count[open]! >= count[last!]!) break;
    count[last!]!--;
    end--;
  }
  return s.slice(0, end);
}

/**
 * A word of a stage: as written (lower case, quotes dropped) and cleaned of brackets and redirects. `sw`: the word is a
 * Windows switch in this shell. In cmd and PowerShell that is `/s`; in sh only `//s`, because Git Bash hands a native
 * program `/c` as the path C:/ and `//c` as the switch /c. `tok`: the word as written (lower case, quotes kept), for the
 * project-folder rule's plain check.
 */
interface Arg { raw: string; w: string; sw: boolean; tok: string }

/** The words of a stage without redirects (`> out`, `2>&1`, `>>log`): what a redirect writes to is not an argument. */
function argWords(stage: string, shell: ShellKind = 'sh'): Arg[] {
  const tokens = stage.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? [];
  const gitBashSwitches = shell === 'sh' && tokens.some((t) => /^\/\/[a-z?][\w:?.-]*$/i.test(t.replace(/["'^]/g, '')));
  const out: Arg[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d?>{1,2}&?\d?$/.test(t)) { i++; continue; }
    if (/^\d?>/.test(t)) continue;
    // find's -exec terminator (\; or ';') is the end of the command it runs, not a `\` drive root
    if (/^(?:\\;|';'|";")$/.test(t) && out.some((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a.w))) continue;
    const lower = t.replace(/["'^]/g, '').toLowerCase();
    const raw = undoubled(lower);
    // in sh, once a stage writes a switch the Git Bash way (//s), its single-slash words are paths (/c is C:/)
    if (raw) { const w = clean(raw); out.push({ raw, w, sw: shell === 'sh' && gitBashSwitches ? raw !== lower : CMD_SWITCH.test(w), tok: t.toLowerCase().replace(/(?<=.)\d?>{1,2}.*$/, '') }); }
  }
  return out;
}

/** A word that opens a group, a subshell or a script block: the command inside starts with it (`(rd`, `{ rm`, `(( `). */
const opensGroup = (raw: string): boolean => /^[({]/.test(raw);
/** cmd's `if` conditions before its command: `if exist x`, `if not defined v`, `if errorlevel 1`, `if /i "a"=="b"`. */
const CMD_IF_TESTS = new Set(['exist', 'defined', 'errorlevel', 'cmdextversion']);

/**
 * Where a command really starts in a stage, read liberally: the start; after a group, subshell or script-block opener;
 * past keywords, conditions and assignments (sh `FOO=1`, PowerShell `$x =`, cmd `if exist x`); then the wrapper-aware
 * positions of commandPositions. A verb counts only here: elsewhere it is an argument (`rg -n del ~`, `git rm`, `echo rm`).
 */
function liberalPositions(args: readonly Arg[]): Set<number> {
  const out = new Set<number>();
  const run = (from: number, to: number) => {
    let k = from;
    let afterIf = false;
    while (k < to) {
      const w = args[k]!.w;
      if (!w || SH_KEYWORDS.has(w) || PS_KEYWORDS.has(w) || /^[a-z_][a-z0-9_]*=/.test(w) || /^\$[\w:{}]+=/.test(w)) { afterIf = w === 'if'; k++; continue; }
      if (w.startsWith('$') && args[k + 1]?.w === '=') { k += 2; continue; }
      if (afterIf && (w === '/i' || w === 'not')) { k++; continue; }
      if (afterIf && CMD_IF_TESTS.has(w)) { k += 2; afterIf = false; continue; }
      if (afterIf && w.includes('==')) { k++; afterIf = false; continue; }
      if (afterIf && CMD_COMPARE.has(args[k + 1]?.w ?? '')) { k += 3; afterIf = false; continue; }
      break;
    }
    for (const p of commandPositions(args.slice(k, to).map((a) => a.w))) out.add(k + p);
  };
  let start = 0;
  for (let i = 1; i < args.length; i++) {
    // a group or script-block opener starts the command inside it; a case pattern (`start)`) starts the command after it
    if (opensGroup(args[i]!.raw)) { run(start, i); start = i; }
    else if (/\)$/.test(args[i - 1]!.raw) && !args[i - 1]!.raw.includes('(')) { run(start, i); start = i; }
  }
  run(start, args.length);
  return out;
}
/** cmd's comparison words: `if %errorlevel% neq 0 …`. */
const CMD_COMPARE = new Set(['equ', 'neq', 'lss', 'leq', 'gtr', 'geq']);

/* ---------- what is protected ---------- */

/**
 * `.` and `..` folded away, never above the first segment, which stays as written (`/`, `c:`, `~`, `$home`,
 * `%userprofile%`): `/home/x/..` is `/home`, `c:/.` is `c:`, `./a/../b` is `b`. Forward slashes only.
 */
function collapseDots(p: string): string {
  const abs = p.startsWith('/');
  const segs = p.split('/').filter((s, i) => !(abs && i === 0 && s === ''));
  const out: string[] = [];
  const anchored = abs || /^(?:[a-z]:|~|\$home|\$\{home\}|%[a-z]+%|\$env:[a-z]+)$/.test(segs[0] ?? '');
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length > (anchored && !abs ? 1 : 0)) out.pop(); continue; }
    out.push(s);
  }
  return abs ? `/${out.join('/')}` : out.join('/') || '.';
}

const WIN_VARS = 'userprofile|systemroot|windir|systemdrive|programfiles|programdata|homedrive';

/** The folders Windows' own variables name, for reading a path written with one (any user name stands for the user). */
const WIN_FOLDERS: Record<string, string> = {
  systemdrive: 'c:', homedrive: 'c:', systemroot: 'c:/windows', windir: 'c:/windows', programfiles: 'c:/program files',
  'programfiles(x86)': 'c:/program files (x86)', programw6432: 'c:/program files', programdata: 'c:/programdata', allusersprofile: 'c:/programdata',
  userprofile: 'c:/users/u', localappdata: 'c:/users/u/appdata/local', appdata: 'c:/users/u/appdata/roaming', temp: 'c:/users/u/appdata/local/temp', tmp: 'c:/users/u/appdata/local/temp',
};

/**
 * A Windows path in the plain drive form the checks read: a PowerShell provider prefix (FileSystem::) dropped, an
 * admin share (\\host\c$\x) read as c:\x, a drive-relative root (\Windows) as c:\Windows, and a Windows variable
 * (%SystemRoot%\System32, $env:LOCALAPPDATA\..\.., %ProgramFiles(x86)%) as the folder it names.
 */
function windowsPath(p: string): string {
  let t = p.replace(/^(?:microsoft\.powershell\.core\\)?filesystem::/, '');
  t = t.replace(/^[\\/]{2}[^\\/]+[\\/]([a-z])\$(?=[\\/]|$)/, '$1:');
  if (/^\\(?![\\])/.test(t)) t = `c:${t}`;
  const v = /^(?:%([\w()]+)%|\$env:([\w()]+)|\$\{env:([\w()]+)\}|\$\{?([a-z]\w*)\}?)(?=[\\/]|$)(.*)$/.exec(t);
  const name = v && (v[1] ?? v[2] ?? v[3] ?? v[4] ?? '').toLowerCase();
  if (v && name && WIN_FOLDERS[name] && !(v[4] && ['temp', 'tmp'].includes(name))) t = WIN_FOLDERS[name] + v[5];
  return t;
}

/**
 * A path whose recursive deletion destroys the machine or a person's data: a drive or file-system root, a system
 * folder, a home folder (or its root), each optionally followed by a separator and a wildcard. A folder INSIDE a
 * home or a project is not one of these: deleting `~/proj/build` or `C:\proj\build` is ordinary work.
 */
export function isProtectedTarget(word: string): boolean {
  // PowerShell's -Path:C:\ form, the \\?\ and \\.\ device prefixes, and sh's escaped spaces name the same folder
  // a target names a root, a drive, a home or a variable: a plain word (most of a command) is none of these, so it is skipped at once
  if (!/[\\/~$%:*?[]/.test(word)) return false;
  // cmd reads , and = as spaces between arguments (`rd /s /q,C:\`), and a PowerShell comma list is every path in it
  // (`C:\,D:\`); a brace list keeps its commas for the expansion below
  if (/[,=]/.test(word) && !/\{[^}]*,/.test(word)) return word.split(/[,=]+/).some((part) => part !== word && isProtectedTarget(part));
  // Windows drops trailing dots from a folder name: %USERPROFILE%. is the home
  const bare = windowsPath(word.split(ESCAPED_SPACE).join(' ').replace(/^-(?:literal)?path:/, '').replace(/^[\\/]{2}[?.][\\/]/, '').replace(/(?<=[^.\\/])\.+$/, ''));
  if (!bare) return false;
  // a brace expansion is every one of its forms: /{etc,usr} is /etc and /usr, /{,} is /
  const brace = /^([^{]*)\{([^{}]*,[^{}]*)\}(.*)$/.exec(bare);
  if (brace) return brace[2]!.split(',').some((alt) => isProtectedTarget(`${brace[1]}${alt}${brace[3]}`));
  // ${HOME%/}, ${HOME:-x}, ${HOME#y}: the home with a modifier is still the home
  if (/^\$\{home[%#:/^,][^}]*\}[\\/]?\*?$/.test(bare)) return true;
  // a whole drive through an admin share (\\localhost\c$)
  if (/^[\\/]{2}[^\\/]+[\\/][a-z]\$[\\/]?\*?$/.test(bare)) return true;
  // every dot-file of a home (~/.*): the configuration of every program the person uses
  if (/^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)[\\/]\.\*$/.test(bare)) return true;
  // the home drive and path written as two variables
  if (/^(?:%homedrive%%homepath%|\$env:homedrive\$env:homepath|\$homedrive\$homepath|\$\{homedrive\}\$\{homepath\})[\\/]?\*?$/.test(bare)) return true;
  const w = collapseDots(bare.replace(/[\\/]+\*(?:\.\*)?$/, '/').replace(/\\/g, '/').replace(/\/+$/, '') || '/');
  if (w === '/' || w === '/*') return true;
  // a wildcard in the first folder below the root (/[c], /?, /c*) reaches a drive or a system folder
  if (/^\/[^/]*[?*[][^/]*$/.test(w)) return true;
  // Git for Windows' tools (rm.exe is on PATH, so cmd.exe reaches it too), Cygwin and WSL name a drive /c, /cygdrive/c or
  // /mnt/c: judged as the drive itself. On a POSIX machine a one-letter top-level folder is refused as well, which costs nothing.
  const drive = /^\/(?:cygdrive\/|mnt\/)?([a-z])(\/.*)?$/.exec(w);
  if (drive) return isProtectedTarget(`${drive[1]}:${drive[2] ?? ''}`);
  if (/^\/users(?:\/[^/]+)?$/.test(w)) return true;
  if (/^[a-z]:\/windows\/system32$/.test(w)) return true;
  if (/^\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var|snap|system|library|applications|volumes|private|users)$/.test(w)) return true;
  if (/^\/usr\/(?:bin|lib|lib64|libexec|sbin|share|local)$/.test(w) || /^\/volumes\/[^/]+$/.test(w) || /^\/var\/lib$/.test(w)) return true;
  if (/^\/home\/[^/]+$/.test(w)) return true;
  if (/^(?:~|\$home|\$\{home(?::[-?=+][^}]*)?\})$/.test(w)) return true;
  // ~name is that user's home (Git Bash: ~alex is C:/Users/alex); ~+ and ~- are the current and the last folder
  if (/^~(?:[a-z0-9._-]+|[+-])$/.test(w)) return true;
  // Git for Windows' own folders under its / (deleting them deletes git and bash)
  if (/^\/(?:mingw32|mingw64|clang32|clang64|clangarm64|ucrt64|cmd|git-bash\.exe|git-cmd\.exe)$/.test(w)) return true;
  if (/^[a-z]:(?:\*(?:\.\*)?)?$/.test(w)) return true;
  // a wildcard in the first folder below a drive (C:\Win*, C:\??????s, C:\W*\S*32) reaches a system folder or the users
  if (/^[a-z]:\/[^/]*[?*[]/.test(w)) return true;
  if (/^[a-z]:\/(?:windows|users|program files|program files \(x86\)|programdata|progra~\d|docume~\d)$/.test(w)) return true;
  if (/^[a-z]:\/users\/[^/]+$/.test(w)) return true;
  if (new RegExp(`^%(?:${WIN_VARS}|homedrive%%homepath)%$`).test(w)) return true;
  if (new RegExp(`^\\$env:(?:${WIN_VARS})$`).test(w)) return true;
  // the same variables as sh writes them (Git Bash inherits the Windows environment)
  if (new RegExp(`^\\$(?:\\{(?:${WIN_VARS})\\}|(?:${WIN_VARS}))$`).test(w)) return true;
  return false;
}

/* ---------- command positions ---------- */

/** Programs that run the rest of the line as the command (`sudo rm …` is an rm); their own options are skipped. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'xargs',
  'timeout', 'stdbuf', 'setsid', 'ionice', 'chroot', 'flock', 'strace', 'ltrace', 'busybox', 'taskset', 'chrt', 'unbuffer', 'caffeinate',
  // cmd's call and start, and wsl, run the command that follows them; eval and PowerShell's iex run their words as a command
  'call', 'start', 'wsl', 'eval', 'iex', 'invoke-expression',
  // ssh-agent runs the command after its options as its child; these run the command that follows them too
  'ssh-agent', 'pkexec', 'fakeroot', 'unshare', 'nsenter', 'systemd-run', 'runuser', 'setpriv', 'coproc', 'parallel', 'watch', 'firejail', 'screen',
  // npx and its kin run the program of the package named after them (npx rimraf /)
  'npx', 'pnpx', 'bunx',
]);
const WRAPPER_OPTS_WITH_ARG = new Set(['-u', '-g', '-p', '-h', '-n', '-s', '-k', '-o', '-e', '-c', '-w', '-t', '-d', '-a', '--distribution', '--user', '--cd', '--signal', '--kill-after']);
/** Wrappers whose first plain word is their own argument, not the command (`timeout 5 rm`, `chroot / rm`, `flock lockfile rm`). */
const WRAPPER_TAKES_ONE = new Set(['timeout', 'chroot', 'flock', 'taskset', 'chrt']);
/** cmd's call and start take /x switches (`start /b`). */
const SLASH_OPTION_WRAPPERS = new Set(['call', 'start']);
/** PowerShell options that take a value. */
const PS_OPTS_WITH_ARG = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-outputformat', '-of', '-inputformat', '-if', '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-version', '-v']);
/** Shells that run the command line after their command flag (`bash -c`, `cmd /c`, `powershell -Command`). */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh', 'mksh', 'cmd', 'powershell', 'pwsh']);
const SHELL_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command']);

/** Delete commands of sh, cmd and PowerShell (with its aliases), and the ones that overwrite before they delete. */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'shred', 'srm', 'rimraf', 'trash', 'trash-put']);
/** PowerShell's and sh's listers: `gci C:\ | Remove-Item` deletes what they list. */
const LIST_VERBS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
const MOVE_VERBS = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const CD_VERBS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
/** cmd's commands, whose options are written /s, /q: after them a /x word is a switch, not Git Bash's /x drive. */
const CMD_SWITCH_VERBS = new Set(['rd', 'rmdir', 'del', 'erase', 'dir', 'icacls', 'takeown', 'robocopy', 'move', 'ren', 'rename', 'cd', 'chdir', 'pushd']);
/** A word that names a program Legion recognises: when a wrapper option might take an argument, such a word is the command. */
const KNOWN_PROGRAMS = new Set([...DELETE_VERBS, ...SHELLS, ...WRAPPERS, 'python', 'python3', 'node', 'perl', 'ruby', 'robocopy', 'rsync', 'chmod', 'chown', 'find', 'git', 'mv', 'dd']);

/**
 * The words of a stage that are in command position, i.e. that RUN: the first word, the word after a wrapper and its
 * options, the word after a shell's command flag, and the word after find's -exec.
 */
function commandPositions(ws: readonly string[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < ws.length) {
    out.push(i);
    const p = program(ws[i]!);
    if (WRAPPERS.has(p)) {
      i++;
      const opt = (w: string) => w.startsWith('-') || /^[a-z_][a-z0-9_]*=/.test(w) || (SLASH_OPTION_WRAPPERS.has(p) && /^\/[a-z]/.test(w));
      // an option that may take an argument does not swallow a word that names a program (`sudo -E rm` reads as `sudo -e rm`)
      while (i < ws.length && opt(ws[i]!)) { if (WRAPPER_OPTS_WITH_ARG.has(ws[i++]!) && !KNOWN_PROGRAMS.has(program(ws[i] ?? ''))) i++; }
      if (WRAPPER_TAKES_ONE.has(p) && i < ws.length && !KNOWN_PROGRAMS.has(program(ws[i]!))) { i++; while (i < ws.length && ws[i]!.startsWith('-')) i++; }
      continue;
    }
    // `direnv exec DIR command` runs the command
    if (p === 'direnv' && ws[i + 1] === 'exec') { i += 3; continue; }
    const flag = SHELLS.has(p) ? ws.findIndex((w, j) => j > i && SHELL_COMMAND_FLAGS.has(w)) : -1;
    if (flag > i) { i = flag + 1; continue; }
    // PowerShell runs its first plain argument as a command even without -Command (`powershell Format-Volume …`);
    // its options that take a value (-ExecutionPolicy Bypass) are stepped over, and -File runs a script, not a command
    if (p === 'powershell' || p === 'pwsh') {
      let j = i + 1;
      while (j < ws.length && ws[j]!.startsWith('-')) { if (ws[j] === '-file' || ws[j] === '-f') { j = ws.length; break; } j += PS_OPTS_WITH_ARG.has(ws[j]!) ? 2 : 1; }
      if (j < ws.length) { i = j; continue; }
    }
    break;
  }
  ws.forEach((w, j) => { if ((w === '-exec' || w === '-execdir') && j + 1 < ws.length) out.push(j + 1); });
  return out;
}

/** Programs that run TEXT as a command (besides the shells): only for these is a quoted string judged as a command of its own. */
const TEXT_RUNNERS = new Set(['eval', 'iex', 'invoke-expression', 'ssh', 'su', 'wsl', 'xargs', 'start', 'watch', 'source', '.', 'runas', 'call', 'invoke-command', 'start-process', 'wmic', 'forfiles', 'schtasks', 'script', 'tmux', 'screen', 'at', 'batch', 'alias', 'trap', 'env', 'parallel', 'nohup', 'setsid']);

/** Where one command ends and the next begins: ; & && || newlines, and the body after do, then or else (at any position). */
const SEGMENTS = /&&|\|\||[;&\n\r]|\b(?:do|then|else)\b(?=\s)/;
/** PowerShell: & is its call operator, not a separator. */
const PS_SEGMENTS = /&&|\|\||[;\n\r]|\b(?:do|then|else)\b(?=\s)/;
/** A PowerShell script block's braces start and end a command of its own (`foreach ($d in $x) { Remove-Item $d }`); `${var}` and `@{…}` are not script blocks. */
const PS_BLOCKS = /(?<![$@])\{|\}/;

/** Whether some command position on the line is a shell or another program that runs text as a command. */
function runsText(cmd: string): boolean {
  for (const seg of splitOutside(cmd, /&&|\|\||[;&|\n\r]/)) {
    const ws = words(seg);
    if (commandPositions(ws).some((i) => { const p = program(ws[i]!); return SHELLS.has(p) || TEXT_RUNNERS.has(p); })) return true;
  }
  return false;
}

/* ---------- standard input run as a script ---------- */

/** Programs that read a script from standard input when no command flag or script file is given (`curl … | bash`). */
const STDIN_RUNNERS = new Set([...SHELLS, 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby']);

/** Whether this pipeline stage hands its standard input to a shell or interpreter as a script. */
function runsStdin(ws: readonly string[]): boolean {
  const pos = commandPositions(ws);
  const last = pos[pos.length - 1];
  if (last === undefined) return false;
  // `… | xargs sh -c`: xargs hands the text to the shell's -c as the command (the -c has nothing after it on the line)
  if (pos.some((i, n) => n > 0 && SHELLS.has(program(ws[i]!)) && program(ws[pos[n - 1]!]!) === 'xargs') && SHELL_COMMAND_FLAGS.has(ws[ws.length - 1]!)) return true;
  // the shell itself is the last command position only when its -c took the rest; read the runner as the program BEFORE that
  const at = pos.length > 1 && SHELL_COMMAND_FLAGS.has(ws[last - 1] ?? '') ? pos[pos.length - 2]! : last;
  const p = program(ws[at]!);
  if (!STDIN_RUNNERS.has(p)) return false;
  const after = ws.slice(at + 1);
  const posixShell = SHELLS.has(p) && p !== 'cmd' && p !== 'powershell' && p !== 'pwsh';
  // `bash -n` only checks the syntax; it runs nothing
  if (posixShell && after.includes('-n')) return false;
  const inline = posixShell ? new Set(['-c']) : p === 'cmd' ? new Set(['/c', '/k']) : (p === 'powershell' || p === 'pwsh') ? new Set(['-c', '-command', '-file', '-f']) : new Set(['-e', '--eval', '-p', '--print', '-c']);
  for (let i = 0; i < after.length; i++) {
    const w = after[i]!;
    // `powershell -c -` reads the command from standard input
    if (inline.has(w)) return after[i + 1] === '-';
    if (!w.startsWith('-') && !w.startsWith('/')) return false; // a script file
  }
  return true;
}

/** The text an echo or printf stage writes, when it is written out on the line (no variable, substitution or escape). */
function literalOutput(stage: string): string | undefined {
  const ws = words(stage);
  if (!['echo', 'printf'].includes(program(ws[0] ?? ''))) return undefined;
  if (/[$`]|\\[0-7xuUe]/.test(stage)) return undefined;
  return ws.slice(1).filter((w) => !/^-[a-z]+$/.test(w)).join(' ');
}

/* ---------- refusal ---------- */

/** Commands that are catastrophic by themselves: judged on the normalised text, so a note or a grep pattern naming one in quotes passes. */
const CATASTROPHIC_COMMANDS: Array<[RegExp, string]> = [
  [/\bmkfs(?:\.\w+)?\b/i, 'formatting a filesystem'],
  [/\bdd\b[^|&;\n]*\bof\s*=\s*['"]?\/dev\//i, 'raw write to a device'],
  [/(?:^|[\s&|;(@])format(?:\.com)?\s+(?:\/\S+\s+)*['"]?[a-z]:/i, 'formatting a drive'],
  [/\bdiskpart\b/i, 'disk partitioning'],
  [/\b(?:shred|wipefs|blkdiscard)\b[^|&;\n]*\/dev\//i, 'wiping a disk device'],
];
/** Shapes that are not words (a fork bomb, a redirect onto a disk): matched anywhere on the line. */
const CATASTROPHIC: Array<[RegExp, string]> = [
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'a fork bomb'],
  [/>\s*['"]?\/dev\/(?:sd|hd|nvme|mmcblk|vd)[a-z0-9]*['"]?\s*(?:$|[;&|\n])/i, 'overwriting a block device'],
  [/(?:of\s*=|>)\s*['"]?(?:\\\\|\/\/)\.(?:\\|\/)(?:physicaldrive\d|[a-z]:)/i, 'raw write to a disk'],
];
/** Whole-machine Windows tools: no target is needed for these to be catastrophic. Matched on the normalised text. */
const CATASTROPHIC_WINDOWS: Array<[RegExp, string]> = [
  [/\bvssadmin(?:\.exe)?\s+delete\s+shadows\b/, 'deleting the system restore copies'],
  [/\bwmic(?:\.exe)?\s+shadowcopy\s+delete\b/, 'deleting the system restore copies'],
  [/\bwbadmin(?:\.exe)?\s+delete\b/, 'deleting the backups'],
  [/\bbcdedit(?:\.exe)?\s+\/delete\b/, 'deleting a boot entry'],
  [/\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine)\\(?:system|software|sam|security)\b/, 'deleting a core part of the registry'],
  [/\bcipher(?:\.exe)?\s+\/w\b/, 'wiping a drive\'s free space'],
  [/\b(?:format-volume|clear-disk|initialize-disk|remove-partition)\b/, 'formatting or wiping a disk'],
];

/** Decoders that turn hidden text into readable text: their output piped into a shell is a command nobody could read first. */
const DECODES = (ws: readonly string[]): boolean => {
  const p = ws.map(program);
  return (p.includes('base64') && ws.some((w) => w === '-d' || w === '--decode'))
    || (p.includes('xxd') && ws.some((w) => w === '-r' || /^-r/.test(w)))
    || (p.includes('openssl') && ws.includes('-d') && ws.some((w) => w === 'base64' || w === 'enc'));
};
/** PowerShell's -EncodedCommand and every prefix PowerShell accepts for it (-e, -ec, -enc, …). */
const PS_ENCODED = /^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/;

/** Why the command runs hidden (decoded or encoded) text as a command, else undefined. Hard refusal: a card could not show it. */
function hiddenPayload(cmd: string, shell: ShellKind): string | undefined {
  if (/frombase64string/i.test(cmd) && /\b(?:iex|invoke-expression)\b/i.test(cmd)) return 'running decoded text as a command';
  for (const segment of splitOutside(cmd, SEGMENTS, shell)) {
    const stages = splitOutside(segment, PIPE, shell).map(words);
    // one pass: once a decoder has run in an earlier stage, a later stage that runs its input as a script is refused
    let decoded = false;
    for (const ws of stages) {
      if (ws.some((w, i) => { const p = program(clean(w)); return (p === 'powershell' || p === 'pwsh') && ws.slice(i + 1).some((x) => PS_ENCODED.test(x)); })) return 'running a hidden (encoded) PowerShell command';
      if (decoded && runsStdin(ws)) return 'running decoded text as a command';
      if (DECODES(ws)) decoded = true;
    }
  }
  return undefined;
}

/** A cmd switch (`/s`, `/q`, `/a:h`): after cmd's own commands it is an option, not Git Bash's `/s` drive. */
const CMD_SWITCH = /^\/[a-z?]+(?::\S*)?$/;
/** A target meaning "everything here": `*`, `./*`, `*.*`, `.`. */
const EVERYTHING_HERE = /^(?:\.[\\/])?\*(?:\.\*)?$|^\.$/;
/** find predicates that narrow what is deleted: `find ~ -name '*.pyc' -delete` is cleaning, `find ~ -delete` is a wipe. */
const FIND_FILTERS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-regex', '-iregex', '-newer', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-empty', '-user', '-group', '-perm', '-links', '-inum', '-samefile', '-lname', '-ilname']);

/**
 * One stage, read for verbs and targets in one pass (linear: a command of 100,000 words is read once, not once per verb).
 * A verb counts where a command starts, read liberally (liberalPositions): behind a group, a subshell, a script block,
 * an assignment, a condition or a wrapper with options, quoted (`"rm" -rf /`) or not; anywhere else it is data.
 */
class Stage {
  readonly ws: string[];
  /** For each word: the index of the last protected target at or after it (-1: none), counting cmd switches or not. */
  private readonly protAfter: Int32Array;
  private readonly protAfterNoSwitch: Int32Array;
  private readonly verbOk: boolean[];
  private readonly sw: boolean[];
  constructor(args: Arg[]) {
    this.ws = args.map((a) => a.w);
    this.sw = args.map((a) => a.sw);
    const n = this.ws.length;
    this.protAfter = new Int32Array(n + 1).fill(-1);
    this.protAfterNoSwitch = new Int32Array(n + 1).fill(-1);
    for (let i = n - 1; i >= 0; i--) {
      const w = this.ws[i]!;
      const prot = isProtectedTarget(w);
      this.protAfter[i] = prot ? i : this.protAfter[i + 1]!;
      this.protAfterNoSwitch[i] = prot && !args[i]!.sw ? i : this.protAfterNoSwitch[i + 1]!;
    }
    const runs = liberalPositions(args);
    this.verbOk = args.map((_a, i) => runs.has(i));
  }
  /** The indexes of the words whose program is one of `verbs`. */
  at(verbs: ReadonlySet<string>): number[] { return this.ws.flatMap((w, i) => (this.verbOk[i] && verbs.has(program(w)) ? [i] : [])); }
  /** Whether a protected target follows word i (for cmd's own commands, a /x switch is not one). */
  protectedAfter(i: number): boolean {
    const table = CMD_SWITCH_VERBS.has(program(this.ws[i]!)) ? this.protAfterNoSwitch : this.protAfter;
    return table[i + 1]! >= 0;
  }
  /** Whether any word of the stage is a protected target. */
  anyProtected(): boolean { return this.protAfter[0]! >= 0; }
  /** The plain words after word i (no options), for commands where one position is the target. */
  plainAfter(i: number, slashOptions: boolean): string[] {
    const out: string[] = [];
    for (let j = i + 1; j < this.ws.length && out.length < 4; j++) { const w = this.ws[j]!; if (!w.startsWith('-') && !(slashOptions && this.sw[j])) out.push(w); }
    return out;
  }
  /** Every plain word after word i (no options), up to the end of the stage. */
  targetsAfter(i: number, slashOptions: boolean): string[] {
    const out: string[] = [];
    for (let j = i + 1; j < this.ws.length; j++) { const w = this.ws[j]!; if (!w.startsWith('-') && !(slashOptions && this.sw[j])) out.push(w); }
    return out;
  }
  has(pred: (w: string) => boolean, from = 0): boolean { for (let j = from; j < this.ws.length; j++) if (pred(this.ws[j]!)) return true; return false; }
  /** Whether this stage RUNS a delete: at a command position, or inside a script block, ForEach-Object or xargs. */
  runsDelete(): boolean {
    return this.at(DELETE_VERBS).length > 0;
  }
}

const deleteMsg = 'a recursive delete of a drive, a system folder or a home folder';

/** Why one command segment (no ; & && || or newline in it) is catastrophic, else undefined. */
function refuseSegment(segment: string, shell: ShellKind): string | undefined {
  const stages = splitOutside(segment, PIPE, shell).map((s) => new Stage(argWords(s, shell)));
  const mirrorMsg = 'mirroring over a drive, a system folder or a home folder (it deletes what is not in the source)';
  const permMsg = 'changing the permissions of a whole drive, system folder or home folder';
  for (const st of stages) {
    const ws = st.ws;
    if (st.at(DELETE_VERBS).some((i) => st.protectedAfter(i))) return deleteMsg;
    // robocopy /MIR or /PURGE: the destination (the second path) loses what the source does not have
    if (st.has((w) => w === '/mir' || w === '/purge') && st.at(new Set(['robocopy'])).some((i) => isProtectedTarget(st.plainAfter(i, true)[1] ?? ''))) return mirrorMsg;
    if (st.has((w) => w.startsWith('--delete')) && st.at(new Set(['rsync'])).some((i) => isProtectedTarget(ws.slice(i + 1).filter((w) => !w.startsWith('-')).at(-1) ?? ''))) return mirrorMsg;
    // taking away every permission or owner of a drive or a home locks the person out of it
    if (st.has((w) => /^-[a-z]*r/.test(w) || w === '--recursive') && st.at(new Set(['chmod', 'chown', 'chgrp', 'setfacl'])).some((i) => st.protectedAfter(i))) return permMsg;
    if (st.has((w) => w === '/t' || w === '/r') && st.at(new Set(['icacls', 'takeown'])).some((i) => st.protectedAfter(i))) return permMsg;
    // moving or renaming a drive, a system folder or a home away (mv ~ /dev/null) is a delete too: the first path is what moves
    if (st.at(MOVE_VERBS).some((i) => isProtectedTarget(st.plainAfter(i, CMD_SWITCH_VERBS.has(program(ws[i]!)))[0] ?? ''))) return 'moving a drive, a system folder or a home folder away';
    // git clean -fdx in a drive root deletes every file git does not track there
    if (st.has((w) => w === 'clean') && st.at(new Set(['git'])).some((i) => ws.some((w, j) => w === '-c' && j > i && isProtectedTarget(ws[j + 1] ?? '')))) return 'cleaning a drive, a system folder or a home folder with git';
    // find with -delete (or -exec rm) from a drive, a system folder or a home, with nothing narrowing what it deletes
    const deletes = st.has((w) => w === '-delete') || ws.some((w, i) => (w === '-exec' || w === '-execdir') && DELETE_VERBS.has(program(ws[i + 1] ?? '')));
    if (deletes && !st.has((w) => FIND_FILTERS.has(w)) && st.at(new Set(['find'])).some((i) => st.protectedAfter(i))) return 'deleting everything under a drive, a system folder or a home folder';
  }
  // a protected path in one stage, a delete RUNNING in a later one: `find / | xargs rm`, `echo ~/* | xargs rm -rf`,
  // `'C:\' | Remove-Item -Recurse`, `gci C:\ | % { rm $_ -r }`
  for (let s = 1; s < stages.length; s++) {
    if (stages[s]!.runsDelete() && stages.slice(0, s).some((st) => st.anyProtected() && !narrowed(st.ws))) return deleteMsg;
  }
  return undefined;
}

/** cmd's `for /r <root> … do del …` and `forfiles /p <root> … /c "… del …"`: a delete over every file under a root. */
function refuseWindowsLoops(scan: string): string | undefined {
  const forR = /(?:^|[\s&|;(@])for\s+\/r\s+("?)([^\s"]+)\1[\s\S]*?\bdo\b[\s(@]*(?:del|erase|rd|rmdir|remove-item|ri)\b/i.exec(scan);
  if (forR && isProtectedTarget(forR[2]!.toLowerCase())) return 'deleting files under a whole drive, a system folder or a home folder';
  const forfiles = /(?:^|[\s&|;(@])forfiles\b([\s\S]*)/i.exec(scan);
  if (forfiles) {
    const rest = forfiles[1]!;
    const root = /\/p\s+("?)([^"\s]+)\1/i.exec(rest)?.[2];
    if (root && isProtectedTarget(root.toLowerCase()) && /\/c\s+["']?[^"']*\b(?:del|erase|rd|rmdir|remove-item)\b/i.test(rest)) return 'deleting files under a whole drive, a system folder or a home folder';
  }
  // .NET's own delete: [IO.Directory]::Delete('C:\', $true)
  for (const m of scan.matchAll(/\[(?:system\.)?io\.(?:directory|file)\]::delete\(\s*["']?([^"',)]+)/gi)) if (isProtectedTarget(m[1]!.toLowerCase())) return deleteMsg;
  return undefined;
}

/**
 * The refusal reason when a command is catastrophic (or runs hidden text), else undefined. Read on the whole line,
 * a segment at a time, with the quoting rules of `shell`; the text of a shell's -c, of a substitution, and of an echo
 * piped into a shell is read too.
 */
export function refuseCatastrophic(raw: string, shell: ShellKind = 'sh', depth = 0): string | undefined {
  const cmd = unglue(ansiC(prepare(raw, shell)));
  const say = (what: string): string => `Refused: this command looks like ${what}, which can destroy the machine or its data. It is blocked for every agent, even full access.`;
  for (const [re, what] of CATASTROPHIC) if (re.test(cmd)) return say(what);
  const hidden = hiddenPayload(cmd, shell);
  if (hidden) return `Refused: this command is ${hidden}. Text that is decoded or encoded cannot be read before it runs, so it is blocked for every agent, even full access. Run the command itself, written out plainly.`;
  // Quoted text of several words on a line that runs no text is data (a commit message, a grep pattern): read it as a
  // space. A one-word quote (`format "c:"`) is kept, unquoted, so quoting a target cannot hide it.
  const text = runsText(cmd) ? cmd : cmd.replace(/"([^"]*)"|'([^']*)'/g, (_m, a?: string, b?: string) => (/\s/.test(a ?? b ?? '') ? ' ' : (a ?? b ?? '')));
  // a Git Bash doubled switch (bcdedit //delete, cipher //w) is the switch the program receives
  const scan = text.replace(/[\^"']/g, '').toLowerCase().replace(/(^|\s)\/\/(?=[a-z?][\w:?.-]*(?:\s|$))/g, '$1/');
  for (const [re, what] of [...CATASTROPHIC_COMMANDS, ...CATASTROPHIC_WINDOWS]) if (re.test(scan)) return say(what);
  const loop = refuseWindowsLoops(cmd);
  if (loop) return say(loop);
  // Each segment: a verb where a command starts, with a protected target after it. Quoted text stays one word (the
  // shell's own reading), so a commit message or grep pattern never splits into verbs. Then `cd /` (or a drive, or a
  // home) and a wipe of everything there. An sh line with an escaped space (`Program\ Files`) is also read with it kept.
  for (const variant of /\\ /.test(cmd) ? [cmd, cmd.replace(/\\ /g, ESCAPED_SPACE)] : [cmd]) {
    let inRoot = false;
    for (const segment of splitOutside(variant, SEGMENTS, shell)) {
      const why = refuseSegment(segment, shell);
      if (why) return say(why);
      const st = new Stage(argWords(segment, shell));
      const c = st.at(CD_VERBS)[0];
      // in sh, cd and pushd are bash's own: /c is the C: drive, never a switch
      if (c !== undefined) { const t = st.plainAfter(c, shell !== 'sh' && CMD_SWITCH_VERBS.has(program(st.ws[c]!)))[0]; inRoot = t !== undefined && isProtectedTarget(t); continue; }
      if (!inRoot) continue;
      // after `cd /`: rm -rf *, del /s /q *, find . -delete, git clean, rsync --delete into `.`, `ls -r | rm`
      const wipe = st.at(DELETE_VERBS).some((i) => st.ws.slice(i + 1).some((w) => EVERYTHING_HERE.test(w)))
        || (st.has((w) => w === '-delete') && !st.has((w) => FIND_FILTERS.has(w)) && st.at(new Set(['find'])).length > 0)
        || (st.has((w) => w === 'clean') && st.at(new Set(['git'])).length > 0)
        || (st.has((w) => w.startsWith('--delete')) && st.at(new Set(['rsync'])).some((i) => EVERYTHING_HERE.test(st.ws.slice(i + 1).filter((w) => !w.startsWith('-')).at(-1) ?? '')))
        || (splitOutside(segment, PIPE, shell).length > 1 && splitOutside(segment, PIPE, shell).slice(1).some((s) => new Stage(argWords(s, shell)).runsDelete()));
      if (wipe) return say('deleting everything in a drive, a system folder or a home folder');
    }
  }
  if (depth < 2) {
    for (const segment of splitOutside(cmd, SEGMENTS, shell)) {
      const stages = splitOutside(segment, PIPE, shell);
      for (let s = 0; s < stages.length; s++) {
        const ws = words(stages[s]!);
        // a shell's -c text, joined as the shell joins it (`bash -c 'r''m -rf /c'`), is a command of its own, in its shell
        const pos = commandPositions(ws);
        for (const [n, i] of pos.entries()) if (/\s/.test(ws[i]!)) { const inner = refuseCatastrophic(ws[i]!, shellOf(n > 0 ? program(ws[pos[n - 1]!]!) : '', shell), depth + 1); if (inner) return inner; }
        // `echo rm -rf /c | sh` runs the echoed text
        const echoed = s > 0 && runsStdin(ws) ? literalOutput(stages[s - 1]!) : undefined;
        if (echoed) { const inner = refuseCatastrophic(echoed, shell, depth + 1); if (inner) return inner; }
      }
    }
    // Start-Process prog -ArgumentList '…' runs prog with that text
    for (const m of cmd.matchAll(/start-process\s+["']?([\w.\\/:-]+)["']?\s+(?:-argumentlist|-args)\s+(["'])([\s\S]*?)\2/gi)) {
      const inner = refuseCatastrophic(`${m[1]} ${m[3]}`, shellOf(program(m[1]!.toLowerCase()), shell), depth + 1);
      if (inner) return inner;
    }
    // a command substitution runs its text as a command: `echo $(rm -rf /)`, backticks the same
    for (const t of new Set(substitutions(cmd, shell))) {
      const inner = refuseCatastrophic(t, shell, depth + 1);
      if (inner) return inner;
    }
    // one plain scan per quote; only when something on the line runs text (a shell's -c, eval, ssh, a pipe into sh)
    if (runsText(cmd)) for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const t = m[1] ?? m[2] ?? '';
      if (!/\s/.test(t)) continue;
      // text after `alias x=` or `trap '…'` or a here-string is a command too
      const inner = refuseCatastrophic(t.replace(/^[\w-]+=/, ''), shell, depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

const LONG_WINDOW = 5_000;
/** Past this length (of the command without its heredoc bodies) even the read costs too much for the core: such a command is carded unread. */
export const MAX_READ_IN_PARTS = 64_000;
/** A command this large is never walked at all (a heredoc body is skipped cheaply, but the walk is still linear in what it must look at). */
const MAX_WALKED = 8_000_000;
/** How much of a too-long statement is re-read in 5,000-character windows, only to name the dangerous text on the card. */
const WINDOW_BUDGET = 16_000;
/** How much of a group of statements opens the next group: a shape shorter than this that spans statements is always whole in one group. */
const LONG_TAIL = 1_000;
/** A line of a window that holds the catastrophic text, so a card can show the dangerous part and not the padding in front of it. */
function dangerousPart(window: string, shell: ShellKind): string {
  for (const piece of window.split(/\r?\n|;|&&|\|\|/)) if (piece.trim() && refuseCatastrophic(piece, shell)) return piece.trim();
  return window;
}

/**
 * A heredoc whose body is run as code: the line before it names a shell, an interpreter or something that runs its input. Its body is not data, so it stays in the scan.
 * (A body that only a file or a plain program receives is data. The list is a heuristic: a body saved to a file and run later is not caught.)
 */
const CODE_FED = /(?:^|[\s;&|(`])(?:(?:sudo|env|exec|nohup|time|command)\s+)*(?:\S*[\\/])?(?:(?:ba|z|da|k|c|a|fi|tc)?sh|pwsh|powershell|cmd|eval|source|\.|ssh|su|xargs|at|batch|crontab|expect|python[\d.]*|node|perl|ruby|php|lua|osascript|sqlite3|psql|mysql|deno|bun|iex|invoke-expression)(?:\.exe)?(?=$|[\s;&|)<>])/i;

/** A command cut into statements, or the length that made it too long to cut. */
type Cut = { statements: string[] } | { tooLong: number };

/**
 * Cuts a command into statements for the long scan, in one linear walk. A run of blanks (and a backslash-newline, a PowerShell backtick-newline, a cmd caret-newline)
 * becomes one space, so padding cannot spread a command's words past the scan window. A statement ends at a newline, `;`, `&&` or `||` outside quotes and parentheses
 * (a pipe stays inside it: `base64 -d | sh` needs both sides). A heredoc body (`<<WORD ... WORD`; a PowerShell here-string) is data and is left out, unless the line
 * that opens it feeds a shell or interpreter, or its word never closes (then nothing is trusted). A `<<` inside quotes, a comment or arithmetic is no heredoc.
 * Stops at once when the rest is more than MAX_READ_IN_PARTS long.
 */
function cutStatements(raw: string, shell: ShellKind): Cut {
  const L = raw.length;
  const statements: string[] = [];
  let parts: string[] = [];
  let from = 0;
  let resid = 0;
  let depth = 0;
  let tick = false;
  let pending: string[] = [];
  const sh = shell === 'sh'; const ps = shell === 'pwsh'; const cmd = shell === 'cmd';
  // blanks: space, tab, CR, FF, VT; PowerShell also takes every Unicode space as a separator
  const blank = (c: number): boolean => c === 32 || c === 9 || c === 13 || c === 12 || c === 11 || (ps && c > 127 && (c === 0xa0 || c === 0x85 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000));
  const flush = (to: number): void => { if (to > from) { parts.push(raw.slice(from, to)); resid += to - from; } };
  // one space for a run of blanks, even when escapes and newlines-joined lines sit between its pieces
  const sp = (): void => { if (parts.length && parts[parts.length - 1] !== ' ') parts.push(' '); };
  // a `<<` that opened a heredoc (its body is cut out, or kept to be read as lines) is made a plain `<`, so the refusal does not skip the lines after it as a body it no longer sees
  // (the separator that ended a statement stays at its end, so a shape that spans one, such as a fork bomb, is still whole in a group)
  const end = (sep = '\n'): void => {
    let s = parts.join('').trim();
    parts = [];
    if (sh && s.includes('<<')) s = s.replace(/(?<!<)<<(?!<)-?/g, '<');
    if (s || sep !== '\n') statements.push(s + sep);
  };
  // the work the search for heredoc closers may do: one body costs its length once, so this allows a few that never close and then trusts no heredoc (all lines are read)
  let budget = 3 * L + 10_000;
  let heredocs = true;
  const over = (): Cut | undefined => (resid > MAX_READ_IN_PARTS ? { tooLong: resid } : undefined);
  let i = 0;
  while (i < L) {
    const c = raw.charCodeAt(i);
    // a quoted run is skipped whole: its blanks and separators are left as they are
    if (c === 39 && !cmd) { // '
      if (sh) { const j = raw.indexOf("'", i + 1); i = j < 0 ? L : j + 1; }
      else { let j = i + 1; for (;;) { const k = raw.indexOf("'", j); if (k < 0) { j = L; break; } if (raw.charCodeAt(k + 1) === 39) { j = k + 2; continue; } j = k + 1; break; } i = j; }
      if (i - from > MAX_READ_IN_PARTS + 1) { flush(i); from = i; const s = over(); if (s) return s; }
      continue;
    }
    if (c === 34) { // "
      let j = i + 1;
      while (j < L) { const d = raw.charCodeAt(j); if (d === 34) { j++; break; } j += (d === 92 && sh) || (d === 96 && ps) ? 2 : 1; }
      i = Math.min(j, L);
      if (i - from > MAX_READ_IN_PARTS + 1) { flush(i); from = i; const s = over(); if (s) return s; }
      continue;
    }
    if (sh && c === 36 && raw.charCodeAt(i + 1) === 39) { // $'..' takes backslash escapes
      let j = i + 2;
      while (j < L) { const d = raw.charCodeAt(j); if (d === 39) { j++; break; } j += d === 92 ? 2 : 1; }
      i = Math.min(j, L);
      continue;
    }
    if (ps && c === 64 && (raw.charCodeAt(i + 1) === 39 || raw.charCodeAt(i + 1) === 34)) { // @' or @" and a newline: a here-string
      const q = raw[i + 1]!;
      let a = i + 2; while (a < L && blank(raw.charCodeAt(a))) a++;
      if (raw.charCodeAt(a) === 10) {
        // the body runs to a line that starts with q@ (blanks before it are allowed: that ends it no later than PowerShell does)
        let found = -1;
        for (let ls = a + 1; ls <= L;) {
          let le = raw.indexOf('\n', ls); if (le < 0) le = L;
          let b = ls; while (b < le && blank(raw.charCodeAt(b))) b++;
          if (raw[b] === q && raw[b + 1] === '@') { found = le; break; }
          budget -= le - ls + 1;
          ls = le + 1;
          if (budget < 0) { found = -1; break; }
        }
        if (found >= 0 && !CODE_FED.test(parts.join('') + raw.slice(from, i))) {
          flush(i + 2); parts.push('\n'); end();
          from = Math.min(found + 1, L); i = from;
          const s = over(); if (s) return s;
          continue;
        }
      }
      i += 2; continue;
    }
    if ((sh && c === 92) || (ps && c === 96)) { // an escape: before a newline it joins the lines, otherwise the next character is plain text
      const n = raw.charCodeAt(i + 1);
      if (n === 10 || (n === 13 && raw.charCodeAt(i + 2) === 10)) { flush(i); sp(); i += n === 13 ? 3 : 2; from = i; const s = over(); if (s) return s; continue; }
      i += 2; continue;
    }
    if (cmd && c === 94) { // ^ before a newline joins the lines
      const n = raw.charCodeAt(i + 1);
      if (n === 10 || (n === 13 && raw.charCodeAt(i + 2) === 10)) { flush(i); sp(); i += n === 13 ? 3 : 2; from = i; const s = over(); if (s) return s; continue; }
    }
    if (blank(c)) {
      let j = i + 1; while (j < L && blank(raw.charCodeAt(j))) j++;
      flush(i); sp(); from = j; i = j;
      const s = over(); if (s) return s;
      continue;
    }
    // a comment: no quote in it opens one, and no `<<` in it starts a heredoc (its text stays in the statement)
    if (c === 35 && !cmd && (i === 0 || blank(raw.charCodeAt(i - 1)) || raw.charCodeAt(i - 1) === 10 || ';&|('.includes(raw[i - 1]!))) {
      const j = raw.indexOf('\n', i); i = j < 0 ? L : j; continue;
    }
    if (ps && c === 60 && raw.charCodeAt(i + 1) === 35) { const j = raw.indexOf('#>', i + 2); i = j < 0 ? L : j + 2; continue; } // <# block comment #>
    if (c === 10) {
      flush(i);
      if (depth > 0 && !pending.length) { parts.push('\n'); i++; from = i; continue; }
      const opener = pending.length ? parts.join('') : '';
      end(); i++; from = i;
      const s = over(); if (s) return s;
      if (pending.length) {
        const words = pending; pending = [];
        // every word must close, and the line that opens them must not feed a shell: otherwise the lines are read like any other
        let at = i; let all = true;
        for (const w of words) {
          let found = -1;
          for (let ls = at; ls <= L;) {
            let le = raw.indexOf('\n', ls); if (le < 0) le = L;
            let a = ls; while (a < le && (raw.charCodeAt(a) === 9 || raw.charCodeAt(a) === 32)) a++;
            if (raw.startsWith(w, a)) { let b = a + w.length; while (b < le && blank(raw.charCodeAt(b))) b++; if (b === le) { found = le; break; } }
            budget -= le - ls + 1;
            ls = le + 1;
            if (budget < 0) { heredocs = false; break; }
          }
          if (found < 0) { all = false; break; }
          at = Math.min(found + 1, L);
        }
        if (all && !CODE_FED.test(opener)) { i = at; from = at; }
      }
      continue;
    }
    if (c === 59 && depth === 0 && !cmd) { flush(i); end(';'); i++; from = i; const s = over(); if (s) return s; continue; }
    if ((c === 38 && raw.charCodeAt(i + 1) === 38) || (c === 124 && raw.charCodeAt(i + 1) === 124)) {
      if (depth === 0) { flush(i); end(raw.slice(i, i + 2)); i += 2; from = i; const s = over(); if (s) return s; continue; }
      i += 2; continue;
    }
    if (cmd && c === 38 && depth === 0) { flush(i); end('&'); i++; from = i; const s = over(); if (s) return s; continue; }
    if (c === 40) { depth++; i++; continue; }
    if (c === 41) { if (depth > 0) depth--; i++; continue; }
    if (sh && c === 96) { depth += tick ? -1 : 1; if (depth < 0) depth = 0; tick = !tick; i++; continue; }
    if (sh && c === 60 && raw.charCodeAt(i + 1) === 60 && raw.charCodeAt(i + 2) !== 60 && raw.charCodeAt(i - 1) !== 60 && depth === 0) {
      // <<WORD or <<-WORD: the word, with its quotes and backslashes taken off, is the line that closes the body
      let j = i + 2; if (raw.charCodeAt(j) === 45) j++;
      while (j < L && blank(raw.charCodeAt(j))) j++;
      let word = '';
      while (j < L) {
        const d = raw.charCodeAt(j);
        if (d === 39 || d === 34) { const k = raw.indexOf(raw[j]!, j + 1); if (k < 0) { j = L; break; } word += raw.slice(j + 1, k); j = k + 1; continue; }
        if (d === 92) { if (j + 1 < L) word += raw[j + 1]; j += 2; continue; }
        if (blank(d) || d === 10 || d === 59 || d === 38 || d === 124 || d === 60 || d === 62 || d === 40 || d === 41) break;
        word += raw[j]; j++;
      }
      if (word && heredocs) pending.push(word);
      i = Math.max(Math.min(j, L), i + 2);
      continue;
    }
    i++;
    if (i - from > MAX_READ_IN_PARTS + 1) { flush(i); from = i; const s = over(); if (s) return s; }
  }
  flush(L);
  end();
  const s = over(); if (s) return s;
  return { statements };
}

/** The refusal read over one stretch of text, and again with its substitutions read flat when it holds three or more (the refusal itself stops at two levels). */
function scanText(text: string, shell: ShellKind): { reason: string; part: string } | undefined {
  let reason = refuseCatastrophic(text, shell);
  let shown = text;
  if (!reason && (text.match(/\$\(|`/g)?.length ?? 0) >= 3) {
    shown = text.replace(/\$\(|[`()]/g, ' ');
    reason = refuseCatastrophic(shown, shell);
  }
  return reason ? { reason, part: dangerousPart(shown, shell) } : undefined;
}

/**
 * The catastrophic check for a command too long to read whole (over MAX_READABLE): the same refusal, read over the command cut into statements (cutStatements).
 * Padding in front of, behind, around or inside the command hides nothing, a heredoc body is data, and the cost stays linear in the length.
 * The statements are read in groups of up to 5,000 characters. A statement that is still longer than that once its blanks are collapsed cannot be judged by
 * reading it: it comes back as `unread`, to be asked about (after a try over its first 16,000 characters in windows, to name the dangerous text on the card).
 * A command with more than MAX_READ_IN_PARTS characters outside its heredoc bodies is not read at all. No hit: it goes on.
 */
export function longCatastrophic(raw: string, shell: ShellKind = 'sh'): { kind: 'found' | 'unread'; reason: string; part: string } | undefined {
  const tooLong = (n: number): { kind: 'unread'; reason: string; part: string } => ({ kind: 'unread', reason: `it is too long to check, even in parts (${n.toLocaleString('en-US')} characters)`, part: raw.slice(0, 1000) });
  if (raw.length > MAX_WALKED) return tooLong(raw.length);
  const cut = cutStatements(raw, shell);
  if ('tooLong' in cut) return tooLong(cut.tooLong);
  let group: string[] = []; let size = 0; let fresh = 0;
  let budget = WINDOW_BUDGET;
  let oversize: string | undefined;
  // the group is read, and its last 1,000 characters of statements open the next one, so a shape of up to 1,000 characters that spans statements is whole in some group
  const readGroup = (keepTail: boolean): { kind: 'found'; reason: string; part: string } | undefined => {
    const hit = fresh ? scanText(group.join(' '), shell) : undefined;
    let k = group.length; let n = 0;
    if (keepTail) while (k > 0 && n + group[k - 1]!.length + 1 <= LONG_TAIL) { n += group[k - 1]!.length + 1; k--; }
    else k = group.length;
    group = group.slice(k); size = n; fresh = 0;
    return hit ? { kind: 'found', ...hit } : undefined;
  };
  for (const st of cut.statements) {
    if (st.length > LONG_WINDOW) {
      const g = readGroup(false); if (g) return g;
      oversize ??= st;
      for (let at = 0; at < st.length && budget > 0; at += 4_000, budget -= 4_000) {
        const hit = scanText(st.slice(at, at + LONG_WINDOW), shell);
        if (hit) return { kind: 'found', ...hit };
      }
      continue;
    }
    if (size + st.length + 1 > LONG_WINDOW) { const g = readGroup(true); if (g) return g; if (size + st.length + 1 > LONG_WINDOW) { group = []; size = 0; } }
    group.push(st); size += st.length + 1; fresh++;
  }
  const g = readGroup(false); if (g) return g;
  if (oversize !== undefined) return { kind: 'unread', reason: `one statement is too long to check (${oversize.length.toLocaleString('en-US')} characters, even with its blanks collapsed)`, part: oversize.slice(0, 1000) };
  return undefined;
}

/**
 * The Windows shells a Bash command starts with a script of their own (`cmd /c ...`, `powershell -Command ...`), each with its script text and the kind to read it as.
 * The script is the rest of the line; one pair of outer quotes is taken off (and `\"` made `"` inside double quotes). Empty when the command starts none.
 */
export function windowsShellTexts(command: string): Array<{ kind: ShellKind; text: string }> {
  const out: Array<{ kind: ShellKind; text: string }> = [];
  const take = (kind: ShellKind, rest: string | undefined): void => {
    let t = (rest ?? '').trim();
    const q = t[0];
    if ((q === '"' || q === "'") && t.length > 1) { const k = t.lastIndexOf(q); if (k > 0) t = t.slice(1, k); if (q === '"') t = t.replace(/\\"/g, '"'); }
    if (t) out.push({ kind, text: t });
  };
  for (const m of command.matchAll(/\bcmd(?:\.exe)?\s+(?:\/\/?[a-z]\s+)*?\/\/?[ck]\s+([^\n]*)/gi)) take('cmd', m[1]);
  for (const m of command.matchAll(/\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*?\s-c(?:ommand)?\s+([^\n]*)/gi)) take('pwsh', m[1]);
  return out;
}

/* ---------- commands that cannot be read ---------- */

/** Words that open a compound command or a test rather than name a program (`do rm …` runs rm; `[ -f x ]` is a test). */
const SH_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'for', 'case', 'esac', 'done', 'fi', '!', '{', '}', '(', ')', '((', '))', '[', '[[', ']', ']]']);
const PS_KEYWORDS = new Set(['do', 'else', 'elseif', 'if', 'while', 'until', 'switch', 'foreach', 'for', 'try', 'catch', 'finally', '{', '}', '(', ')']);
/** Keywords followed by a condition in parentheses (PowerShell `if ($x) { … }`): the condition is not the program. */
const CONDITION_KEYWORDS = new Set(['if', 'elseif', 'while', 'switch', 'foreach', 'for']);
/** A program word only known when the command runs: a variable or substitution ($, backtick), cmd's %VAR% and !VAR!, or a brace expansion. */
const BUILT_AT_RUN = /[$`]|%[^%\s]+%|![^!\s]+!|^\{[^}]*,[^}]*\}$/;
/** Environment variables that name a folder the system or a tool sets up, so `$HOME/.local/bin/tool` names a written-out program. */
const KNOWN_FOLDERS = 'home|pwd|oldpwd|userprofile|localappdata|appdata|programfiles|programfiles\\(x86\\)|programdata|systemroot|windir|temp|tmp|tmpdir|xdg_[a-z_]+|nvm_dir|cargo_home|rustup_home|gopath|goroot|java_home|android_home|android_sdk_root|virtual_env|conda_prefix|pyenv_root|rbenv_root|volta_home|pnpm_home|bun_install|deno_install|github_workspace|runner_temp|runner_tool_cache';
const PATH_FROM_KNOWN = new RegExp(`^(?:\\$(?:env:)?\\{?(${KNOWN_FOLDERS})\\}?|%(${KNOWN_FOLDERS})%)[\\\\/][^$%\`!]*[^\\\\/$%\`!]$`);
/** Tools whose whole purpose is to print shell setup for `eval "$(tool …)"`. */
const INIT_TOOLS = new RegExp('^\\$\\((?:[\\w./\\\\-]*[\\\\/])?(?:'
  + 'ssh-agent(?:\\s+-[a-z])*'
  + '|direnv\\s+hook\\s+\\w+'
  + '|fnm\\s+env(?:\\s+--?[\\w=-]+)*'
  + '|(?:pyenv|rbenv|nodenv)\\s+init(?:\\s+-)?(?:\\s+--?[\\w-]+)*'
  + '|brew\\s+shellenv'
  + '|(?:zoxide|starship)\\s+init\\s+\\w+(?:\\s+--?[\\w-]+)*'
  + '|(?:mise|rtx)\\s+activate\\s+\\w+'
  + '|conda\\s+shell\\.\\w+\\s+hook'
  + '|opam\\s+env(?:\\s+--?[\\w=-]+)*'
  + '|(?:gh|kubectl|helm|rustup|poetry|pnpm|npm|bun|deno)\\s+completion(?:\\s+--?[\\w-]+)*(?:\\s+\\w+)?'
  + ')\\)$');
/** PowerShell programs that run a script block given to them. */
const BLOCK_RUNNERS = new Set(['invoke-command', 'icm', 'start-job', 'start-threadjob']);
/** A delete target that is nothing but a variable or a substitution: if it is empty or unexpected, the delete reaches a root. */
const TARGET_FROM_VARIABLE = /^(?:[\\/]|[a-z]:[\\/]?|\/[a-z]\/|~[\\/]|\$home[\\/])?(?:\$\{?[\w:]+\}?|\$\(.*\)|`.*`|%[\w~:]+%|%%?\w|![\w]+!|@\w+)[\\/]?\*?$/;
/** A recursive delete flag in sh, cmd and PowerShell. */
const RECURSIVE = (w: string): boolean => /^-[a-z]*r/.test(w) || w === '--recursive' || w === '/s' || /^-rec/.test(w);

const BUILT = 'the program it runs is only known when it runs (it is built from a variable or another command)';
const PIPED = 'it runs the output of another command as a script, which cannot be read before it runs';
const VAR_DELETE = 'what it deletes is only known when it runs (the folder comes from a variable)';

/**
 * The text a variable target stands for when the command itself sets it ONCE, to a written-out value, as a statement
 * of its own before the delete (`S="C:/tmp/x"; rm -rf "$S"`, `$d = 'out'; Remove-Item $d -Recurse`). Anything else
 * (set twice, set from another variable or command, set only for one command as in `S=x rm -rf $S`) is not known.
 */
function literalTarget(w: string, cmd: string): string | undefined {
  const m = /^(?:\$\{?|\$env:)([a-z_]\w*)\}?([\\/].*)?$/i.exec(w);
  if (!m) return undefined;
  const name = m[1]!;
  const sets = [...cmd.matchAll(new RegExp(`(?:^|[;&\\n]\\s*)(?:export\\s+|set\\s+)?(?:\\$(?:env:)?)?${name}\\s*=\\s*("(?:\\$env:\\w+|\\$\\{env:\\w+\\}|\\$home|\\$\\{home\\}|%\\w+%)?[^"$\`%]*"|'[^']*'|[^\\s;&|$\`"'()]+)\\s*(?=[;&\\n]|$)`, 'gi'))];
  if (sets.length !== 1 || (cmd.match(new RegExp(`\\b${name}\\s*=`, 'gi')) ?? []).length !== 1) return undefined;
  // every other mention must be a plain use ($S, ${S}, "$S/x"): a bare name is something else setting it (read S,
  // for S in, local S, unset S, Set-Variable S), and a use followed by an operator or in a loop header changes it
  // ($S += '..', $d, $e = …, foreach ($d in …))
  const [from, to] = [sets[0]!.index!, sets[0]!.index! + sets[0]![0].length];
  for (const o of cmd.matchAll(new RegExp(`(\\$\\{?|\\$env:)?\\b${name}\\b\\}?`, 'gi'))) {
    if (o.index! >= from && o.index! < to) continue; // the assignment itself
    const after = cmd.slice(o.index! + o[0].length);
    if (!o[1]) {
      // the name as a word of its own (read S, for S in, S+=x, S[0]=x) sets it; inside another word (mc-edge-profile) it does not
      const own = /(?:^|[\s(;|&{,])$/.test(cmd.slice(Math.max(0, o.index! - 1), o.index!)) && /^(?:[\s;)|&}=,[]|[-+*/.%?:]=|\+\+|--|$)/.test(after);
      if (own) return undefined;
      continue;
    }
    if (!/^(?:[\s"'/\\;)|&}]|$)/.test(after) || /^(?:\+\+|--)|^\s*(?:[-+*/.%?:]?=|,|in\b)/i.test(after)) return undefined;
    if (/(?:foreach|for)\s*\(\s*$/i.test(cmd.slice(Math.max(0, o.index! - 20), o.index!))) return undefined;
  }
  return sets[0]![1]!.replace(/^["']|["']$/g, '').toLowerCase() + (m[2] ?? '');
}
/**
 * A program word that is a variable the command sets once to a written-out program (`$c="C:\\x\\tool.exe"; & $c`), when
 * that program is an ordinary one: never a shell, a runner, a wrapper or a delete, which would need the full reading.
 */
function knownProgram(w: string, cmd: string): boolean {
  const lit = literalTarget(w, cmd);
  if (!lit || BUILT_AT_RUN.test(lit) || /\s/.test(lit.replace(/^.*[\\/]/, ''))) return false;
  const p = program(lit);
  return !(DESTRUCTIVE.has(p) || SHELLS.has(p) || TEXT_RUNNERS.has(p) || WRAPPERS.has(p) || STDIN_RUNNERS.has(p) || BLOCK_RUNNERS.has(p) || PERM_VERBS.has(p) || p === 'find');
}
/** A delete target named by a variable, unless the command sets it to a written-out value that is not protected. */
const unknownTarget = (w: string, cmd: string): boolean => {
  if (!TARGET_FROM_VARIABLE.test(w)) return false;
  const known = literalTarget(w, cmd);
  return known === undefined || known === '' || isProtectedTarget(known);
};

/** Whether `name` is assigned in the command itself (then `$name/…` is the agent's own text, not the system's folder). */
const assigned = (cmd: string, name: string): boolean => new RegExp(`(?:^|[\\s;&|])(?:export\\s+|set\\s+)?(?:\\$env:)?${name}\\s*=`, 'i').test(cmd);

/** The program a word names when it is a known folder variable in front of a written-out file, else undefined. */
function fromKnownFolder(w: string, cmd: string): string | undefined {
  const m = PATH_FROM_KNOWN.exec(w);
  if (!m) return undefined;
  return assigned(cmd, (m[1] ?? m[2] ?? '').replace(/\\/g, '')) ? undefined : program(w);
}

/**
 * Why the floor cannot judge this command by reading it, else undefined. `shell` is the shell that runs it: PowerShell
 * builds programs only through its call operators, iex and script blocks (`$i++` and `[math]::Round(1)` are expressions);
 * sh and cmd run a program word made from a variable. Variables and substitutions in ARGUMENTS are ordinary and pass.
 */
export function unjudgeableCommand(cmd: string, shell: ShellKind = 'sh', depth = 0): string | undefined {
  if (cmd.length > MAX_READABLE) return `it is too long to read safely (${cmd.length.toLocaleString('en-US')} characters)`;
  if (depth > 3) return 'it nests commands too deeply to read';
  // `iex(irm …)` is `iex (irm …)`
  const text = unglue(prepare(cmd, shell)).replace(/\b(iex|invoke-expression)\(/gi, '$1 (');
  // a quote that never closes: the shell would read the rest of the line differently from any reading here
  const reading = readLine(text, shell);
  if (reading.open) return 'its quotes do not close, so it cannot be read safely';
  if (reading.heredocToRunner) return 'it runs a script written into the command (a heredoc into a shell)';
  // a substitution is judged on its own below; while the words are read it is one word ($S), so `$(git describe)` stays
  // whole (nested ones too); the setup printed by an init tool (`eval "$(ssh-agent -s)"`) is a plain word
  let flat = text.replace(new RegExp(INIT_TOOLS.source.slice(1, -1), 'gi'), 'init-setup');
  const subst = shell === 'pwsh' ? /\$\([^()]*\)/g : /\$\([^()]*\)|`[^`]*`/g;
  for (let prev = ''; prev !== flat;) { prev = flat; flat = flat.replace(subst, '$S'); }
  for (const segment of splitOutside(flat, shell === 'pwsh' ? PS_SEGMENTS : SEGMENTS, shell)) {
    const stages = splitOutside(segment, PIPE, shell);
    for (let s = 0; s < stages.length; s++) {
      const why = shell === 'pwsh'
        ? splitOutside(stages[s]!, PS_BLOCKS, 'pwsh').reduce<string | undefined>((found, part) => found ?? psStage(part, text, depth), undefined)
        : shStage(stages[s]!, text, shell, depth);
      if (why) return why;
      const ws = words(stages[s]!);
      // `printf "ls\n" | bash` runs text that is on the line (refuseCatastrophic reads it); anything else is unseen
      if (s > 0 && runsStdin(ws) && literalOutput(stages[s - 1]!) === undefined) return PIPED;
    }
    // Fail closed: a command that deletes, moves or changes permissions AND names a drive, a system folder or a home,
    // in a shape the refusal above did not read as a delete of that folder (a loop, a case branch, an alias, a pipe),
    // is asked about rather than assumed safe.
    if (riskyMix(segment, shell)) return RISKY;
  }
  // a substitution's own text is a command too
  for (const t of new Set(substitutions(text, shell))) {
    const inner = unjudgeableCommand(t, shell, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/** Commands that delete, move or change permissions, for the fail-closed mix check. */
const DESTRUCTIVE = new Set([...DELETE_VERBS, ...MOVE_VERBS, 'robocopy', 'rsync', 'chmod', 'chown', 'chgrp', 'setfacl', 'icacls', 'takeown', 'format', 'wipefs']);
const RISKY = 'it names a drive, a system folder or a home folder together with a command that deletes, moves or changes permissions, in a form Legion cannot read as safe';

/** Whether a segment has a destructive verb outside quotes and a protected target anywhere (riskyMix tier of the floor). */
function riskyMix(segment: string, shell: ShellKind): boolean {
  const outside = words(maskQuotes(segment, shell)).map((w) => program(clean(w)));
  const recursive = outside.some((w) => /^-[a-z]*r/.test(w) || w === '--recursive' || w === '/t' || w === '/r');
  // a permission change of the folder itself (chmod 755 ~) is ordinary; a recursive one reaches everything below it
  const deletes = outside.some((p) => DESTRUCTIVE.has(p) && !MOVE_VERBS.has(p) && (!PERM_VERBS.has(p) || recursive))
    || (outside.includes('find') && outside.includes('-delete') && !outside.some((w) => FIND_FILTERS.has(w)))
    || (outside.includes('git') && outside.includes('clean'))
    || DELETE_METHOD.test(maskQuotes(segment, shell));
  // a delete method on an object ((Get-Item C:\Users).Delete(), gci C:\ | % { $_.Delete() }): its path sits inside the
  // expression. Only a call outside quotes and heredocs counts (map.delete(k) in a script's text is not one)
  if (DELETE_METHOD.test(maskQuotes(segment, shell)) && segment.toLowerCase().split(/[\s()'",;{}|]+/).some((p) => isProtectedTarget(p))) return true;
  const moves = outside.some((p) => MOVE_VERBS.has(p));
  if (!deletes && !moves) return false;
  // after cmd's own commands a /x word is a switch (`icacls dist /T`), not Git Bash's /t drive
  const switches = outside.some((p) => CMD_SWITCH_VERBS.has(p)) || shell === 'cmd';
  const stages = splitOutside(segment, PIPE, shell);
  return stages.some((stage) => {
    const args = argWords(stage);
    // a listing narrowed by a filter (gci ~ -Filter *.tmp, find ~ -name '*.pyc') names only the files that match
    if (narrowed(args.map((a) => a.w))) return false;
    // a move's destination is where things go, not what is lost: only its sources (every path but the last, or
    // everything but -Destination's value) count when the stage only moves
    let skip = new Set<number>();
    if (!deletes) {
      const at = args.findIndex((a) => MOVE_VERBS.has(program(a.w)));
      const dest = args.findIndex((a, i) => i > at && /^-dest(?:ination)?$/.test(a.w));
      if (dest > at) skip = new Set([dest + 1]);
      else { const plain = args.flatMap((a, i) => (i > at && !a.w.startsWith('-') && !(switches && CMD_SWITCH.test(a.w)) ? [i] : [])); if (plain.length > 1) skip = new Set([plain.at(-1)!]); }
    }
    return args.some((a, i) => !skip.has(i) && !(switches && CMD_SWITCH.test(a.w)) && isProtectedTarget(a.w));
  });
}

/** .NET and COM delete calls: [IO.Directory]::Delete(…), $x.Delete(), .DeleteFolder(…), ::DeleteDirectory(…). */
const DELETE_METHOD = /(?:\.|::)delete(?:folder|directory|file)?\s*\(/i;
/** Permission commands: only a recursive one is a risk to a whole folder. */
const PERM_VERBS = new Set(['chmod', 'chown', 'chgrp', 'setfacl', 'icacls', 'takeown']);
/** A listing narrowed to the files that match a filter: find's predicates, PowerShell's -Filter and -Include. */
const narrowed = (ws: readonly string[]): boolean => {
  const p = program(clean(ws[0] ?? ''));
  return (p === 'find' || LIST_VERBS.has(p)) && ws.some((w) => FIND_FILTERS.has(w) || /^-(?:filt|filte|filter|incl|inclu|includ|include)$/.test(w));
};

/** The kind of shell a word in command position starts, for the text after its command flag. */
const shellOf = (p: string, fallback: ShellKind): ShellKind => (p === 'powershell' || p === 'pwsh' ? 'pwsh' : p === 'cmd' ? 'cmd' : SHELLS.has(p) ? 'sh' : fallback);

/** One pipeline stage of a POSIX sh or cmd command. */
function shStage(stage: string, all: string, shell: ShellKind, depth: number): string | undefined {
  // without redirects (`{ …; } > out`, `exec > log 2>&1`) and cmd's echo-off @
  let ws = argWords(stage).map((a) => a.raw.replace(/^@/, ''));
  if (!ws.length) return undefined;
  // a test, an arithmetic check, a loop or case header, or a function definition is not a program
  if (/^(?:\[\[?|\(\()/.test(ws[0]!) || ((ws[0] === 'while' || ws[0] === 'until' || ws[0] === 'if' || ws[0] === '!') && /^(?:\[\[?|\(\()/.test(ws[1] ?? ''))) return undefined;
  if (ws[0] === 'for' || ws[0] === 'select') return undefined; // its body runs after `do`, a segment of its own
  if (ws[0] === 'case') { const j = ws.findIndex((w) => /\)$/.test(w) && !w.includes('(')); if (j < 0) return undefined; ws = ws.slice(j + 1); }
  // a function definition (f() { …, f(){ …, function f { …): the command after its opening brace is judged like any other
  if (/^[\w.-]+\(\)/.test(ws[0]!) || ws[0] === 'function') {
    ws = ws[0] === 'function' ? ws.slice(2) : [ws[0]!.replace(/^[\w.-]+\(\)/, ''), ...ws.slice(1)];
    if (ws[0] === '()') ws = ws.slice(1);
    if (ws[0]?.startsWith('{')) ws = [ws[0].slice(1), ...ws.slice(1)];
    ws = ws.filter((w, i) => i > 0 || w !== '');
    if (!ws.length) return undefined;
  }
  // leading assignments (`VERSION=$(git describe) npm run build`), keywords and cmd's `if` conditions are not the program
  let k = 0;
  let afterIf = false;
  for (;;) {
    const w = ws[k];
    if (w === undefined) break;
    if (SH_KEYWORDS.has(w) || /^[a-z_][a-z0-9_]*=/.test(w)) { afterIf = w === 'if'; k++; continue; }
    if (afterIf && (w === '/i' || w === 'not')) { k++; continue; }
    if (afterIf && CMD_IF_TESTS.has(w)) { k += 2; afterIf = false; continue; }
    if (afterIf && w.includes('==')) { k++; afterIf = false; continue; }
    if (afterIf && CMD_COMPARE.has(ws[k + 1] ?? '')) { k += 3; afterIf = false; continue; }
    break;
  }
  ws = ws.slice(k);
  if (!ws.length || /^(?:\[\[?|\(\()/.test(ws[0]!)) return undefined;
  const pos = commandPositions(ws);
  for (const [n, i] of pos.entries()) {
    const w = ws[i]!;
    const prev = n > 0 ? program(ws[pos[n - 1]!]!) : '';
    // after eval or iex, a parenthesised expression is the text that runs (`iex (irm https://…)`), not a subshell
    if (n > 0 && w.startsWith('(') && ['eval', 'iex', 'invoke-expression'].includes(prev)) return BUILT;
    if (INIT_TOOLS.test(w) || w === 'init-setup') continue;
    // a shell's -c text is a command line of its own, in that shell's rules
    if (/\s/.test(w)) { const inner = unjudgeableCommand(w, shellOf(prev, shell), depth + 1); if (inner) return inner; continue; }
    // a subshell `(cd ui` names a plain program after its parenthesis
    const bare = w.replace(/^\(+/, '');
    if (!bare) continue;
    const known = fromKnownFolder(bare, all);
    const prog = known ?? program(bare);
    if (!known && BUILT_AT_RUN.test(bare) && !knownProgram(bare, all)) return BUILT;
    if (!known && !/^[\w./\\:+~@-]+$/.test(bare)) return BUILT;
    if (DELETE_VERBS.has(prog) && ws.slice(i + 1).some(RECURSIVE) && ws.slice(i + 1).some((x) => !/^-|^\/[a-z?]$/.test(x) && unknownTarget(x, all))) return VAR_DELETE;
    // a delete target written with escapes ($'\x2f' is /) is only known once the shell decodes it
    if (DELETE_VERBS.has(prog) && /\$'[^']*\\/.test(stage)) return VAR_DELETE;
  }
  // `bash <(curl …)`, `source <(…)`: a script made by another command
  const last = pos[pos.length - 1];
  const runner = last === undefined ? '' : program(ws[last]!);
  if ((STDIN_RUNNERS.has(runner) || runner === 'source' || runner === '.') && ws.some((x) => x.startsWith('<('))) return PIPED;
  return undefined;
}

/** One pipeline stage of a PowerShell command. */
function psStage(stage: string, all: string, depth: number): string | undefined {
  let ws = words(stage);
  // keywords, conditions in parentheses and assignments (`$x = …`, `$env:X='y'`) come before the statement itself
  let k = 0;
  for (;;) {
    const w = ws[k];
    if (w === undefined) break;
    if (PS_KEYWORDS.has(w) || /^\$[\w:{}]+=/.test(w)) { k++; continue; }
    if (w.startsWith('$') && ws[k + 1] === '=') { k += 2; continue; }
    if (w.startsWith('(') && k > 0 && CONDITION_KEYWORDS.has(ws[k - 1]!)) { k++; continue; }
    break;
  }
  ws = ws.slice(k);
  if (!ws.length) return undefined;
  const raw = stage.toLowerCase();
  // a script built from text and run: [scriptblock]::Create(…), [powershell]::Create(), .Invoke()
  if (/\[(?:system\.management\.automation\.)?(?:scriptblock|powershell)\]::create\b/.test(raw)) return 'it builds a script from text and runs it';
  const head = ws[0]!;
  // the call operators run what follows them: & $cmd, & ('r'+'m'), . { … } (a written-out path is readable)
  if (head === '&' || head === '.') {
    const target = ws[1] ?? '';
    if (fromKnownFolder(target, all)) return undefined;
    if (knownProgram(target, all)) return undefined;
    if (/^[$({[]/.test(target) || BUILT_AT_RUN.test(target)) return BUILT;
    return undefined;
  }
  // an expression statement ($x + 1, $i++, [math]::Round(1), (Get-Date).Year, "text") runs no program
  if (/^[$([\d"']/.test(head)) return undefined;
  const prog = program(head);
  if (['iex', 'invoke-expression'].includes(prog)) {
    const arg = ws.slice(1).filter((w) => !w.startsWith('-'))[0];
    if (arg === undefined) return undefined; // `… | iex`: the stdin check reads it
    if (/^[$(]/.test(arg) || arg.includes('(')) return BUILT;
    return unjudgeableCommand(arg, 'pwsh', depth + 1);
  }
  if (BLOCK_RUNNERS.has(prog) && ws.slice(1).some((x) => x.startsWith('{') || x === '-scriptblock')) return 'it runs a PowerShell script block, which is only known when it runs';
  // a splat (Remove-Item @p) hides its parameters, -Recurse and -Path included: what it deletes is not on the line
  if (DELETE_VERBS.has(prog) && ws.slice(1).some((w) => /^@\w+$/.test(w))) return VAR_DELETE;
  if (DELETE_VERBS.has(prog) && ws.slice(1).some(RECURSIVE)) {
    // Remove-Item -Recurse (Get-PSDrive C).Root, or $target: the folder is only known when it runs
    const targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    if (targets.some((w) => w.startsWith('(') || (unknownTarget(w, all) && !fromKnownFolder(w, all)))) return VAR_DELETE;
  }
  // powershell -c "…", bash -c "…": the inner text in its own shell's rules
  for (const [n, w] of ws.entries()) if (n > 0 && /\s/.test(w) && SHELL_COMMAND_FLAGS.has(ws[n - 1]!)) {
    const inner = unjudgeableCommand(w, shellOf(program(ws[n - 2] ?? ''), 'pwsh'), depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/* ---------- the project folder and the folders above it ---------- */

/*
 * Narrow proof (fix round 2; Claude Code: "a command the shell parser can't trace, such as one that changes directory more than
 * once or runs a subshell, prompts"). A delete is free only when EVERY target is PROVABLY placed strictly inside the project (or
 * the working folder), or entirely outside them and their parents. Anything else could reach them, so it is critical.
 * Placed: a plain word of letters, digits, space and . _ - / \ : (quotes only around whole parts; the globs * ? [ ] are read as
 * patterns; a ~ only inside an 8.3 name), with no :: provider prefix, no share or device form, no X: without a separator, no
 * backslash in sh, and no segment that ends in a dot or a space except . and .. (Windows trims those). In sh, .. is folded on the
 * POSIX form first (Git Bash's / holds every drive), and only then are /x/, /mnt/x/ and /cygdrive/x/ read as drive x; a path that
 * climbs to / and goes on, or ends there, is not placed.
 * Where the shell is: KNOWN only when the line moves at most once, by a plain cd, Set-Location, sl or pushd to a placed word at the
 * START of the line, followed only by && to the end (if that cd fails, nothing after it runs). Any other move (a second cd, a cd
 * after ; & || | or a newline, in a loop, a function or a group, an alias, a sourced or called script, popd, pushd +N, a drive
 * switch, SetLocation, a redefined cd, CDPATH) makes the folder unknown for that line and for the rest of the run. With the folder
 * unknown, a relative word is critical when it could name a protected folder from somewhere (., .., a glob, app, work/app).
 * A line that makes a drive or link alias (subst, New-PSDrive, net use, mklink, ln -s, a junction) makes every delete on it critical.
 * Stated limits (not read here): git's clean command (it removes untracked files, not the folder), `node -e` / `python -c` / a
 * script file calling a delete, a target that arrives through `xargs` or stdin in sh, 8.3 short names of the project path (only
 * the home's is read), symlinks, junctions and drive aliases made before the line, Git Bash mounts other than the drives (/tmp and
 * /usr are read as folders of their own), a CDPATH set before the run, and no OS sandbox (reading only, no I/O).
 */

/**
 * Where a command runs. `cwd`: the folder the shell is in (absent: not known). `cwds`: every folder the shell may be in (a shell
 * that keeps its folder between calls hands back what the last call returned); each is judged on its own and each counts as a
 * working folder. `roots`: the project's folders. `extras`: further working folders, of which only a glob directly under one
 * counts, not the folder itself. `home`: the person's home folder.
 */
export interface CriticalWhere { cwd?: string; cwds?: string[]; roots: string[]; extras?: string[]; home: string }
/**
 * What reading a command found: why it is critical (`reason`, and `target` for a card); `cwd`, the folder the line's last `cd`
 * moved to (absent: none, or lost); `cwds`, every folder the shell may be in after the line, the ones it started in included
 * (absent: not known). Keep `cwds` for the next call whether or not this one runs: the folders before a `cd` stay candidates.
 */
export interface CriticalRead { reason?: string; target?: string; cwd?: string; cwds?: string[] }

/** At most this many candidate folders are followed; past that, the folder counts as not known. */
const MAX_CWDS = 8;
/** Delete commands this rule reads: the floor's, and the del-cli package. */
const CRIT_DELETE_VERBS = new Set([...DELETE_VERBS, 'del-cli']);
/** Package runners that run a package's program after a sub-command: `pnpm dlx rimraf`, `yarn dlx`, `npm exec`, `npm x`. */
const PKG_RUNNERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const PKG_RUN_SUBS = new Set(['dlx', 'exec', 'x']);
/** PowerShell's delete cmdlet takes its paths from the pipeline when none is written. */
const PS_PIPE_DELETES = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);
const GET_ITEM = new Set(['get-item', 'gi', 'resolve-path', 'rvpa']);
/** Get-ChildItem switches (no value) and options that take one: any other option makes the listing unreadable. */
const GCI_SWITCHES = new Set(['-recurse', '-r', '-force', '-file', '-directory', '-dir', '-hidden', '-system', '-readonly', '-name', '-followsymlink', '-s', '-a']);
const GCI_VALUES = new Set(['-filter', '-include', '-exclude', '-depth', '-attributes', '-erroraction', '-ea', '-path', '-literalpath']);

/** A path in the one form paths are compared in: lower case, forward slashes, Git Bash /d/x as d:/x, dots folded, no trailing slash. */
function plainPath(p: string): string {
  let t = windowsPath(p.toLowerCase()).replace(/\\/g, '/').replace(/(?!^)\/{2,}/g, '/');
  const drive = /^\/(?:cygdrive\/|mnt\/)?([a-z])(\/.*)?$/.exec(t);
  if (drive) t = `${drive[1]}:${drive[2] ?? ''}`;
  // Windows drops trailing spaces and dots from a name: "D:/work/app " and D:/work/app. are D:/work/app
  t = t.split('/').map((s) => (s === '.' || s === '..' ? s : s.replace(/[ .]+$/, '') || s)).join('/');
  return collapseDots(t);
}
const segsOf = (plain: string): string[] => (plain === '/' ? [''] : plain.split('/'));
const joinSegs = (s: readonly string[]): string => s.join('/') || '/';

/** A path part that is a pattern (sh, PowerShell and cmd globs; bash's extglob). */
const GLOB_SEG = /[*?[]|[@+!]\(/;
/** A glob that can match nearly any name (`*`, `.*`, `?*`, `**`, `.[!.]*`): no letter or digit outside a bracket class. */
const wideGlob = (seg: string): boolean => /[@+!]\(/.test(seg) || !/[a-z0-9]/.test(seg.replace(/\[[^\]]*\]/g, ''));
const globToRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[[^\]]*\]/g, '.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

type Rel = 'self' | 'parent' | 'everything' | 'pattern';
/**
 * How target `t` relates to folder `s` (both as path parts): s itself, a folder above it, a wide glob directly in it, or a glob
 * at or above s's level before the two part ways (it may match s or a folder above it: not proven otherwise, so it counts).
 */
function relation(t: readonly string[], s: readonly string[]): { rel: Rel; at: number } | undefined {
  for (let k = 0; k < Math.min(t.length, s.length); k++) {
    if (GLOB_SEG.test(t[k]!)) return { rel: 'pattern', at: k };
    if (t[k] !== s[k]) return undefined;
  }
  if (t.length < s.length) return { rel: 'parent', at: t.length - 1 };
  if (t.length === s.length) return { rel: 'self', at: t.length - 1 };
  const next = t[s.length]!;
  return t.length === s.length + 1 && GLOB_SEG.test(next) && wideGlob(next) ? { rel: 'everything', at: s.length - 1 } : undefined;
}

/** A folder as the owner wrote it: the spelling of a known folder it is, sits in or sits above; else the plain path in Windows form. */
function shownAs(plain: string, known: readonly string[]): string {
  const p = segsOf(plain);
  for (const k of known) {
    const ks = segsOf(plainPath(k));
    const words = k.split(/[\\/]+/);
    while (words.length > 1 && words[words.length - 1] === '') words.pop();
    if (words.length !== ks.length) continue;
    const n = Math.min(p.length, ks.length);
    if (joinSegs(p.slice(0, n)) !== joinSegs(ks.slice(0, n))) continue;
    const sep = k.includes('\\') ? '\\' : '/';
    const s = [...words.slice(0, n), ...p.slice(n)].join(sep);
    return /^[a-z]:$/i.test(s) ? s + sep : s || sep;
  }
  const s = /^[a-z]:/.test(plain) ? plain[0]!.toUpperCase() + plain.slice(1).replace(/\//g, '\\') : plain;
  return /^[a-z]:$/i.test(s) ? `${s}\\` : s;
}

/** What a placed word may hold once its quotes are off: letters, digits, space, . _ - / \ :, the globs * ? [ ], and ~ (only in an 8.3 name). */
const PLAIN = /^[\p{L}\p{N} ._\-/\\:*?[\]~]*$/u;
/** An 8.3 short name (DANIEL~1, PROGRA~2.OLD): the one place a ~ is an ordinary character. */
const SHORT_NAME = /^[^~]{1,6}~\d+(?:\.[^.~]{1,3})?$/;
const DRIVE = /^[a-z]:[\\/]/;

/**
 * The value of a delete or cd word when it is plain (see the rule above), else undefined. `tok` is the word as written (lower
 * case, quotes kept). Quotes may wrap whole parts; an escape, a doubled quote, a variable, a bracket or any other character is not plain.
 */
function plainValue(tok: string, shell: ShellKind): string | undefined {
  if (tok.includes(ESCAPED_SPACE) || /["']["']/.test(tok)) return undefined;
  let v = '';
  let len = 0;
  for (const m of tok.matchAll(/"([^"]*)"|'([^']*)'|[^"']+/g)) {
    // cmd has no single quotes: a ' is part of the name
    if (m[2] !== undefined && shell === 'cmd') return undefined;
    v += m[1] ?? m[2] ?? m[0];
    len += m[0].length;
  }
  if (len !== tok.length || !PLAIN.test(v) || v.startsWith('~')) return undefined;
  if (shell === 'sh' && v.includes('\\')) return undefined;
  if (/^[\\/]{2}/.test(v)) return undefined;
  if (v.slice(DRIVE.test(v) ? 2 : 0).includes(':')) return undefined;
  for (const s of v.split(shell === 'sh' ? '/' : /[\\/]/)) {
    if (s.includes('~') && !SHORT_NAME.test(s)) return undefined;
    if (s && s !== '.' && s !== '..' && /[ .]$/.test(s)) return undefined;
  }
  return v;
}

/** Where a plain word points: an absolute path as parts; relative parts when no folder is known; 'here' (dots, ..) with no folder; 'could' when it cannot be placed. */
type Placed = { segs: string[] } | { rel: string[] } | 'here' | 'could';
function place(v: string, shell: ShellKind, cwd: string | undefined): Placed {
  const w = shell === 'sh' ? v : v.replace(/\\/g, '/');
  const abs = DRIVE.test(w) || w.startsWith('/');
  if (!abs && cwd === undefined) {
    const rel = w.split('/').filter((s) => s && s !== '.');
    return !rel.length || rel.includes('..') ? 'here' : { rel };
  }
  // a working folder is a drive path (Windows) or a POSIX path (Linux, macOS); anything else cannot be placed
  const posixCwd = cwd !== undefined && cwd.startsWith('/');
  if (cwd !== undefined && !posixCwd && !/^[a-z]:(?:\/|$)/.test(cwd)) return 'could';
  if (posixCwd && shell !== 'sh' && !DRIVE.test(w)) {
    // PowerShell on Linux or macOS: / is the root, .. stops there
    const out: string[] = [];
    for (const s of (w.startsWith('/') ? w : `${cwd}/${w}`).split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return out.length ? { segs: ['', ...out] } : 'could';
  }
  if (shell !== 'sh') {
    // \work in cmd and PowerShell is on the drive of the folder the shell is in; .. stops at a drive's root
    if (!DRIVE.test(w) && w.startsWith('/') && cwd === undefined) return 'could';
    const p = DRIVE.test(w) ? w : w.startsWith('/') ? cwd!.slice(0, 2) + w : `${cwd}/${w}`;
    const out: string[] = [];
    for (const s of p.slice(2).split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return { segs: [p.slice(0, 2), ...out] };
  }
  // sh: fold on the POSIX form first (Git Bash's / holds the drives), then read /x/, /mnt/x/ and /cygdrive/x/ as drive x
  const drive = DRIVE.test(w);
  const posix = drive ? `/${w[0]}${w.slice(2)}` : w.startsWith('/') ? w : posixCwd ? `${cwd}/${w}` : `/${cwd![0]}${cwd!.slice(2)}/${w}`;
  const out: string[] = [];
  let atRoot = false;
  for (const s of posix.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (drive && out.length <= 1) return 'could'; out.pop(); if (!out.length) atRoot = true; continue; }
    if (atRoot) return 'could';
    out.push(s);
  }
  if (!out.length) return 'could';
  const m = out[0] === 'mnt' || out[0] === 'cygdrive' ? 1 : 0;
  if (/^[a-z]$/.test(out[m] ?? '')) return { segs: [`${out[m]}:`, ...out.slice(m + 1)] };
  if (m || out[0] === 'proc') return 'could';
  return { segs: ['', ...out] };
}

/** With no known folder: could a relative word name one of `selves` (or a wide glob in one) from somewhere? Only if its plain part is a run of their parts. */
function relativeCouldReach(rel: readonly string[], selves: ReadonlyArray<readonly string[]>): boolean {
  const g = rel.findIndex((s) => GLOB_SEG.test(s));
  const lit = g < 0 ? rel : rel.slice(0, g);
  if (!lit.length) return true;
  const want = lit.join('/');
  return selves.some((s) => { for (let end = lit.length; end <= s.length; end++) if (s.slice(end - lit.length, end).join('/') === want) return true; return false; });
}

/** A line that redefines cd (a function, an alias, doskey; the data-folder guard's pattern): a cd then does whatever it was made to do. */
const NAV_NAMES = '(?:cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)';
const REDEFINES_CD = new RegExp(`(?:^|[\\s;&|(){}])(?:function\\s+${NAV_NAMES}\\b|${NAV_NAMES}\\s*\\(\\s*\\)|alias\\s+${NAV_NAMES}=|(?:set-alias|sal|new-alias|nal)\\s+(?:-name\\s+)?${NAV_NAMES}\\b|doskey\\s+${NAV_NAMES}=)`, 'i');
/** Every word that moves the shell's folder, wherever it stands (a loop body, a function, a group, after any separator). */
const NAV = new RegExp(`(?:^|[\\s;&|(){}@\\\\])${NAV_NAMES}(?=$|[\\s;&|(){}'"])`, 'gi');
/** The same, as programs at command positions (a quoted or escaped name, "cd" or c\d, and a module-qualified cmdlet included). */
const NAV_PROGRAMS = new Set([...CD_VERBS, 'popd', 'pop-location']);
/** Other ways a line moves the folder: SetLocation and the current-directory APIs, CDPATH, bash's cdable_vars. */
const MOVES = /setlocation\s*\(|setcurrentdirectory\s*\(|currentdirectory\s*=|cdpath=|cdable_vars/i;
/** A script run in the shell itself (it may cd): sh's source and . and eval; PowerShell's . and & and a .ps1 file, iex; cmd's call and a .bat or .cmd file. */
const SAME_SHELL: Record<ShellKind, RegExp> = {
  sh: /(?:^|[;&|({}\n])\s*(?:source|\.|eval)\s/,
  pwsh: /(?:^|[;|({}\n]|&&)\s*(?:\.|&|iex|invoke-expression|import-module|ipmo)\s|\.psm?1\b/i,
  cmd: /(?:^|[;&|(\n@])\s*call\s|\.(?:bat|cmd)\b/i,
};
/** cmd and PowerShell: `D:` alone switches drive (to the folder last used there). */
const DRIVE_SWITCH = /(?:^|[;&|\n(])\s*[a-z]:\s*(?=$|[;&|\n)])/i;
/** A drive or link alias made on the line: what it names is only known on disk. */
const ALIAS_MAKERS = /(?:^|[\s;&|(){}@])(?:subst|new-psdrive|ndr|mklink|junction(?:64)?|net\s+use|ln\s+(?:-[a-z]*s[a-z]*|--symbolic)|new-item\b[^\n;|]*-itemtype\s+["']?(?:symboliclink|junction|hardlink))(?=$|[\s;&|)])/i;

/** A path written as an option's value: -Path:x and -LiteralPath:x anywhere; in PowerShell any -Name:value (-Pa:, -LP:, -PSPath:), except $true and $false. */
function colonValue(a: Arg, shell: ShellKind): Word | undefined {
  const m = (shell === 'pwsh' ? /^-[a-z]+:/ : /^-(?:literal)?path:/).exec(a.w);
  if (!m) return undefined;
  const w = a.w.slice(m[0].length);
  return w && !/^\$(?:true|false)$/.test(w) ? { w, tok: a.tok.slice(a.tok.indexOf(':') + 1) } : undefined;
}

/** A target of a delete or cd: the word (cleaned, for the card) and as written (quotes kept, for the plain check). */
interface Word { w: string; tok: string }
/** The words after word i that a delete takes as paths: no options, except PowerShell's -Path:x and -LiteralPath:x (the value is the path). */
function pathWords(args: readonly Arg[], i: number, slashOptions: boolean, shell: ShellKind): Word[] {
  const out: Word[] = [];
  for (let j = i + 1; j < args.length; j++) {
    const a = args[j]!;
    const v = colonValue(a, shell);
    if (v) { out.push(v); continue; }
    if (a.w.startsWith('-') || (slashOptions && a.sw) || !a.w) continue;
    out.push({ w: a.w, tok: a.tok });
  }
  return out;
}

/** Splits at `re` outside quotes, like splitOutside, and keeps the separator after each part ('' after the last). */
function splitKeepingSeps(s: string, re: RegExp, shell: ShellKind): Array<{ part: string; sep: string }> {
  const masked = maskQuotes(s, shell);
  let g = GLOBAL.get(re);
  if (!g) { g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`); GLOBAL.set(re, g); }
  const out: Array<{ part: string; sep: string }> = [];
  let last = 0;
  for (const m of masked.matchAll(g)) { out.push({ part: s.slice(last, m.index), sep: m[0] }); last = m.index! + m[0].length; }
  out.push({ part: s.slice(last), sep: '' });
  return out;
}

/**
 * The folder word of the line's one plain move: a cd, chdir, pushd, Set-Location or sl at the start of the line, as the only
 * command of its part (cmd's /d, PowerShell's -Path and -LiteralPath allowed), with only && after it to the end. Else undefined.
 */
function leadCd(parts: ReadonlyArray<{ part: string; sep: string }>, shell: ShellKind): Word | undefined {
  if (parts.slice(0, -1).some((p) => p.sep !== '&&')) return undefined;
  const first = parts[0]!.part;
  if (/[(){}|]/.test(maskQuotes(first, shell))) return undefined;
  const args = argWords(first, shell);
  if (!args.length || !CD_VERBS.has(program(args[0]!.w))) return undefined;
  const rest = args.slice(1).filter((a) => !(shell === 'cmd' && a.w === '/d'));
  if (rest.length === 2 && shell === 'pwsh' && (rest[0]!.w === '-path' || rest[0]!.w === '-literalpath')) return { w: rest[1]!.w, tok: rest[1]!.tok };
  if (rest.length !== 1) return undefined;
  const v = shell === 'pwsh' ? colonValue(rest[0]!, shell) : undefined;
  return v ?? (rest[0]!.w.startsWith('-') ? undefined : { w: rest[0]!.w, tok: rest[0]!.tok });
}

/** A folder the shell may be in (plain), and the working folder it came from (that one is protected like the project). */
interface Cand { p: string; base?: string }
const union = (a: readonly Cand[] | undefined, b: readonly Cand[] | undefined): Cand[] | undefined => {
  if (!a || !b) return undefined;
  const seen = new Map<string, Cand>();
  for (const c of [...a, ...b]) seen.set(`${c.p}|${c.base ?? ''}`, c);
  return seen.size > MAX_CWDS ? undefined : [...seen.values()];
};

interface Hit { target: string; reason: string; rel?: Rel }

/**
 * Reads a command for a delete that could reach the project folder or a folder above it (see criticalDelete). Same readers as the
 * refusal: segments, stages, delete verbs at command positions, the text of a shell's -c and of substitutions. It hands back every
 * folder the shell may be in afterwards (the ones it started in included), for the next call of a shell that keeps its folder;
 * none when the line moved the folder in a way that is not read (the folder is then not known for the rest of the run).
 */
export function criticalDeleteRead(raw: string, shell: ShellKind, where: CriticalWhere): CriticalRead {
  const start: Cand[] | undefined = where.cwds?.length
    ? where.cwds.map((c) => ({ p: plainPath(c), base: plainPath(c) }))
    : where.cwd ? [{ p: plainPath(where.cwd), base: plainPath(where.cwd) }] : undefined;
  const r = readCritical(raw, shell, where, start, 0);
  const cwds = union(start, r.cands);
  return { ...(r.hit ? { reason: r.hit.reason, target: r.hit.target } : {}), ...(r.moved ? { cwd: r.moved } : {}), ...(cwds ? { cwds: cwds.map((c) => c.p) } : {}) };
}

function readCritical(raw: string, shell: ShellKind, where: CriticalWhere, startCands: Cand[] | undefined, depth: number): { hit?: Hit; cands?: Cand[]; moved?: string } {
  let cmd = unglue(prepare(raw, shell));
  // cmd and PowerShell run `cd..` and `cd\` as cd .. and cd \
  if (shell !== 'sh') cmd = cmd.replace(/(^|[\s;&|(])(cd|chdir)(?=[.\\/])/gi, '$1$2 ');
  const text = shell === 'sh' && /\\ /.test(cmd) ? cmd.replace(/\\ /g, ESCAPED_SPACE) : cmd;
  const masked = maskQuotes(text, shell);
  // the whole line in one group, `(cd build && rm -rf *)`: read what is inside it (sh's subshell never moves the shell)
  const group = /^\s*\(/.exec(masked);
  if (group) {
    const end = closingParen(text, group[0].length, shell, { chars: 4 * text.length + 20_000 });
    if (end >= 0 && !masked.slice(end + 1).trim()) {
      const r = readCritical(text.slice(group[0].length, end), shell, where, startCands, depth);
      return shell === 'sh' ? { ...(r.hit ? { hit: r.hit } : {}), ...(startCands ? { cands: startCands } : {}) } : r;
    }
  }
  const home = where.home;
  const known = [...where.roots, ...(where.cwd ? [where.cwd] : []), ...(home ? [home] : []), ...(where.extras ?? [])].filter(Boolean);
  const show = (segs: readonly string[]) => shownAs(joinSegs(segs), known);
  const roots = where.roots.filter(Boolean).map((r) => segsOf(plainPath(r)));
  const homeSegs = home ? segsOf(plainPath(home)) : undefined;
  const extras = (where.extras ?? []).filter(Boolean).map((e) => segsOf(plainPath(e)));
  // with no known folder, a relative word may be read from anywhere; in sh also from Git Bash's /, where drive D: is d/
  const posixOf = (s: readonly string[]) => (/^[a-z]:$/.test(s[0] ?? '') ? [[s[0]![0]!, ...s.slice(1)], ['mnt', s[0]![0]!, ...s.slice(1)], ['cygdrive', s[0]![0]!, ...s.slice(1)]] : []);
  const anywhere = [...roots, ...(homeSegs ? [homeSegs] : [])];
  const selvesAnywhere = shell === 'sh' ? [...anywhere, ...anywhere.flatMap(posixOf)] : anywhere;

  /** What deleting absolute path `t` does, read from a folder that came from working folder `base`. */
  const judgeAbs = (t0: readonly string[], base: string | undefined, word: string): Hit | undefined => {
    let t = t0;
    // the home folder by its 8.3 short name (C:\Users\DANIEL~1), any user's: a home folder
    if (homeSegs && homeSegs.length >= 3 && homeSegs[0] === t[0] && homeSegs[1] === 'users' && t[1] === 'users' && /^[^/]{1,6}~\d+$/.test(t[2] ?? '')) t = [...homeSegs.slice(0, 3), ...t.slice(3)];
    const selves: Array<{ s: string[]; what: string }> = roots.map((s) => ({ s, what: 'the project folder' }));
    if (base !== undefined && !roots.some((s) => joinSegs(s) === base)) selves.push({ s: segsOf(base), what: 'the working folder' });
    for (const { s, what } of selves) {
      const rel = relation(t, s);
      if (!rel) continue;
      const at = show(s.slice(0, rel.at + 1));
      if (rel.rel === 'self') return { rel: 'self', target: `${what} ${at}`, reason: `it deletes ${what} ${at}` };
      if (rel.rel === 'parent') return { rel: 'parent', target: at, reason: `it deletes ${at}, a folder that holds the project` };
      if (rel.rel === 'everything') return { rel: 'everything', target: `everything in ${at}`, reason: `it deletes everything in ${at}, which holds the project` };
      return { rel: 'pattern', target: `what ${word} matches, which can be ${at}`, reason: `it deletes what the pattern ${word} matches, and that can be ${at}, which holds the project` };
    }
    if (homeSegs) {
      const rel = relation(t, homeSegs);
      if (rel?.rel === 'self') return { rel: 'self', target: 'your home folder', reason: 'it deletes your home folder' };
      if (rel?.rel === 'everything') return { rel: 'everything', target: 'everything in your home folder', reason: 'it deletes everything in your home folder' };
      if (rel) return { rel: rel.rel, target: show(homeSegs.slice(0, rel.at + 1)), reason: `it deletes ${show(homeSegs.slice(0, rel.at + 1))}, which holds your home folder` };
    }
    for (const e of extras) if (relation(t, e)?.rel === 'everything') return { rel: 'everything', target: `everything in ${show(e)}`, reason: `it deletes everything in ${show(e)}` };
    return undefined;
  };
  const could = (word: string): Hit => ({ target: `${word} (Legion cannot tell where that is before it runs; it may be the project folder)`, reason: `what it deletes (${word}) is only known when it runs, and it may be the project folder or a folder above it` });
  const unknownHere: Hit = { target: 'the folder the shell is in', reason: 'it deletes the folder the shell is in, which may be the project folder' };

  // where the shell is: known only after one plain cd at the start, followed by && only; any other move loses it
  const parts = splitKeepingSeps(text, SEGMENTS, shell);
  while (parts.length > 1 && !parts[parts.length - 1]!.part.trim()) parts.pop();
  const lead = leadCd(parts, shell);
  const byText = [...masked.matchAll(NAV)].length + (shell === 'pwsh' ? substitutions(text, shell).reduce((n, t) => n + [...t.matchAll(NAV)].length, 0) : 0);
  const byParser = parts.reduce((n, { part }) => n + splitOutside(part, PIPE, shell).reduce((m, t) => m + new Stage(argWords(t, shell)).at(NAV_PROGRAMS).length, 0), 0);
  const navs = Math.max(byText, byParser);
  let lost = navs > (lead ? 1 : 0) || REDEFINES_CD.test(text) || MOVES.test(text) || SAME_SHELL[shell].test(text) || (shell !== 'sh' && DRIVE_SWITCH.test(masked));
  let cands = lost ? undefined : startCands;
  let moved: string | undefined;
  if (lead && !lost) {
    const v = plainValue(lead.tok, shell);
    const to = (cwd: string | undefined): string | undefined => {
      const res = v ? place(v, shell, cwd) : 'could';
      // a drive path; a POSIX path (its first part is the empty root) only on Linux and macOS, where the folders are POSIX: in Git Bash a
      // folder such as /tmp or /usr is somewhere in the Git install, so there such a cd leaves the folder unknown
      const posixOk = cwd !== undefined ? cwd.startsWith('/') : roots.length > 0 && roots.every((s) => s[0] === '');
      return typeof res !== 'string' && 'segs' in res && (/^[a-z]:$/.test(res.segs[0]!) || (posixOk && res.segs[0] === '' && res.segs.length > 1)) && !res.segs.some((s) => GLOB_SEG.test(s)) ? joinSegs(res.segs) : undefined;
    };
    const next = (cands ?? [{ p: undefined as string | undefined }]).map((c) => ({ ...c, p: to(c.p) }));
    // cmd's cd to another drive without /d sets that drive's folder but stays where it is
    const crossDrive = shell === 'cmd' && !/\s\/d\b/i.test(parts[0]!.part) && next.some((n, k) => cands?.[k] && n.p?.slice(0, 2) !== cands[k]!.p.slice(0, 2));
    if (crossDrive || next.some((n) => n.p === undefined)) { lost = true; cands = undefined; }
    else { cands = next as Cand[]; moved = cands[cands.length - 1]!.p; }
  }
  const aliased = ALIAS_MAKERS.test(text);

  /** What deleting `word` does, from every folder the shell may be in. */
  const judge = (word: Word): Hit | undefined => {
    if (!word.w) return undefined;
    // a PowerShell array (a, b) or cmd's , ; = between arguments, outside quotes: every path in it
    const list = shell === 'pwsh' ? /,/ : shell === 'cmd' ? /[,;=]/ : undefined;
    if (list && list.test(maskQuotes(word.tok, shell))) {
      const masked = maskQuotes(word.tok, shell);
      let from = 0;
      for (let k = 0; k <= masked.length; k++) {
        if (k < masked.length && !list.test(masked[k]!)) continue;
        const tok = word.tok.slice(from, k);
        from = k + 1;
        const h = tok ? judge({ w: tok.replace(/["']/g, ''), tok }) : undefined;
        if (h) return h;
      }
      return undefined;
    }
    const v = aliased ? undefined : plainValue(word.tok, shell);
    if (v === undefined) return could(word.w);
    if (cands === undefined) {
      const res = place(v, shell, undefined);
      if (res === 'could') return could(word.w);
      if (res === 'here') return unknownHere;
      if ('rel' in res) return relativeCouldReach(res.rel, selvesAnywhere) ? unknownHere : undefined;
      return judgeAbs(res.segs, undefined, word.w);
    }
    for (const c of cands) {
      const res = place(v, shell, c.p);
      if (typeof res === 'string' || !('segs' in res)) return could(word.w);
      const h = judgeAbs(res.segs, c.base, word.w);
      if (h) return h;
    }
    return undefined;
  };

  let hit: Hit | undefined;
  const slashFor = (args: readonly Arg[], i: number): boolean => shell !== 'sh' && CMD_SWITCH_VERBS.has(program(args[i]!.w));
  const inner = (t: string, k: ShellKind) => { const r = readCritical(t, k, where, cands, depth + 1); if (r.hit) hit ??= r.hit; };
  const dot: Word = { w: '.', tok: '.' };

  for (const { part: segment } of parts) {
    const stageTexts = splitOutside(segment, PIPE, shell);
    const stages = stageTexts.map((t) => argWords(t, shell));
    for (const [s, args] of stages.entries()) {
      const st = new Stage(args);
      const ws = st.ws;
      const verbs = [...st.at(CRIT_DELETE_VERBS)];
      // pnpm dlx rimraf, yarn dlx, npm exec [--] rimraf, npm x del-cli
      for (const j of st.at(PKG_RUNNERS)) {
        if (!PKG_RUN_SUBS.has(ws[j + 1] ?? '')) continue;
        let k = j + 2;
        while (k < ws.length && ws[k]!.startsWith('-')) k += ws[k] === '-p' || ws[k] === '--package' ? 2 : 1;
        if (k < ws.length && CRIT_DELETE_VERBS.has(program(ws[k]!))) verbs.push(k);
      }
      for (const i of verbs) {
        // find's -exec rm takes what find found ({}, judged by the find rule below), up to its ; or +
        const execd = /^-(?:exec|execdir|ok|okdir)$/.test(ws[i - 1] ?? '');
        const targets = pathWords(args, i, slashFor(args, i), shell).filter((t) => !(execd && /^(?:\{\}|\+|;|\\;)$/.test(t.w)));
        for (const t of targets) hit ??= judge(t);
        // PowerShell: a delete with no path deletes what the command before the pipe hands it
        if (!targets.length && s > 0 && (shell === 'pwsh' || program(ws[i]!) === 'remove-item' || program(ws[i]!) === 'ri') && PS_PIPE_DELETES.has(program(ws[i]!))) hit ??= piped(stages[s - 1]!);
      }
      // find with -delete (or -exec rm): its start folders are what it deletes, unless a narrow -name keeps it to files inside
      const findDeletes = st.has((w) => w === '-delete') || ws.some((w, k) => (w === '-exec' || w === '-execdir') && CRIT_DELETE_VERBS.has(program(ws[k + 1] ?? '')));
      if (findDeletes) {
        const names = ws.flatMap((w, k) => (w === '-name' || w === '-iname' ? [ws[k + 1] ?? ''] : []));
        const narrow = names.length > 0 && names.every((n) => n && !wideGlob(n)) && !st.has((w) => w === '-o' || w === '-or' || w === '-not' || w === '!' || w === ',');
        for (const i of st.at(new Set(['find']))) {
          const rest = args.slice(i + 1);
          const first = rest.findIndex((a) => /^[-!(]/.test(a.w));
          const starts = rest.slice(0, first < 0 ? undefined : first).map((a) => ({ w: a.w, tok: a.tok }));
          for (const start of starts.length ? starts : [dot]) {
            const h = judge(start);
            const base = start.w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
            if (h && !(narrow && h.rel === 'self' && !names.some((n) => globToRe(n).test(base)))) hit ??= h;
          }
        }
      }
      // robocopy /MIR or /PURGE: the destination loses what the source does not have
      if (st.has((w) => w === '/mir' || w === '/purge')) for (const i of st.at(new Set(['robocopy']))) { const dest = pathWords(args, i, true, shell)[1]; if (dest) hit ??= judge(dest); }
      if (depth < 2) {
        // a shell's -c text (bash -lc, sh -ic and other clusters with c; PowerShell's -Command and its short forms; cmd /c /k /r) is a command of its own
        const pos = commandPositions(ws);
        for (const [n, i] of pos.entries()) if (/\s/.test(ws[i]!)) inner(ws[i]!, shellOf(n > 0 ? program(ws[pos[n - 1]!]!) : '', shell));
        for (const k of st.at(SHELLS)) {
          const kind = shellOf(program(ws[k]!), shell);
          const flag = ws.findIndex((w, j) => j > k && (kind === 'sh' ? /^-[a-z]*c[a-z]*$/.test(w) : kind === 'pwsh' ? /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/.test(w) : /^\/[ckr]$/.test(w)));
          if (flag > k && ws[flag + 1] !== undefined) inner(ws[flag + 1]!, kind);
        }
      }
    }
  }
  if (depth < 2) for (const t of new Set(substitutions(text, shell))) inner(t, shell);
  return { ...(hit ? { hit } : {}), ...(cands ? { cands } : {}), ...(moved ? { moved } : {}) };

  /** What a pipeline hands Remove-Item: what Get-ChildItem lists (a glob over its folder), what Get-Item names, else not known. */
  function piped(prev: readonly Arg[]): Hit | undefined {
    const st = new Stage([...prev]);
    const list = st.at(LIST_VERBS)[0];
    const item = st.at(GET_ITEM)[0];
    if (item !== undefined) { const ps = pathWords(prev, item, false, shell); return ps.length ? ps.map((p) => judge(p)).find(Boolean) : judge(dot); }
    if (list === undefined) return could('what the command before the pipe hands it');
    const paths: Word[] = [];
    let filter: Word | undefined;
    for (let j = list + 1; j < prev.length; j++) {
      const a = prev[j]!;
      const w = a.w;
      if (!w) continue;
      const v = colonValue(a, shell);
      if (v) { paths.push(v); continue; }
      if (w === '-path' || w === '-literalpath') { const n = prev[++j]; if (n) paths.push({ w: n.w, tok: n.tok }); continue; }
      if (w === '-filter' || w === '-include') { const n = prev[++j]; filter = n ? { w: n.w, tok: n.tok } : undefined; continue; }
      if (GCI_VALUES.has(w)) { j++; continue; }
      if (GCI_SWITCHES.has(w)) continue;
      if (a.sw && shell === 'cmd') continue;
      if (w.startsWith('-')) return could('what the command before the pipe lists');
      if (paths.length && filter === undefined) filter = { w, tok: a.tok }; else paths.push({ w, tok: a.tok });
    }
    const glob = filter && !wideGlob(filter.w) ? filter : { w: '*', tok: '*' };
    for (const p of paths.length ? paths : [dot]) {
      const h = judge({ w: `${p.w.replace(/[\\/]+$/, '')}/${glob.w}`, tok: `${p.tok.replace(/[\\/]+$/, '')}/${glob.tok}` });
      if (h) return h;
    }
    return undefined;
  }
}

/**
 * Why a command deletes, or could delete, the project folder or a folder above it, else undefined (Claude Code's critical
 * paths: the working folder and its parents, a glob directly in a working folder, the home folder and its 8.3 name), read
 * with a narrow proof: a delete is free only when every target is provably inside the project or outside it and its parents.
 * Pure, no I/O. The card or the refusal around it is the engine's.
 */
export function criticalDelete(cmd: string, shell: ShellKind, where: CriticalWhere): string | undefined {
  return criticalDeleteRead(cmd, shell, where).reason;
}
