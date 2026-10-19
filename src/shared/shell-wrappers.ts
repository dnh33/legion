/**
 * Programs that only run another command: `timeout`, `nice`, `time`. The shell classifier judges the command they wrap, so it looks through them
 * with these functions. (The secret-read check does not need their options: it tries every later word as the start of the wrapped command.)
 * Pure; no file access.
 */

const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const lc = (s: string): string => s.toLowerCase().replace(/\.exe$/, '');

/** The wrapper's name when `first` is one, else undefined. */
export const wrapperName = (first: string): 'timeout' | 'nice' | 'time' | undefined => {
  const n = lc(first);
  return n === 'timeout' || n === 'nice' || n === 'time' ? n : undefined;
};

/**
 * The words of the command a wrapper runs, or null when `words` is not a wrapper or its options are not a shape this function knows.
 * timeout: `--preserve-status`, `--foreground`, `-v`, `-k <time>`, `-s <signal>` (and their `=` forms), then a duration, then the command.
 * nice: `-n <number>`, `-<number>` or `--adjustment=<number>`, then the command. time: `-p`, then the command.
 */
export function unwrapCommand(words: readonly string[]): string[] | null {
  const name = words.length ? wrapperName(words[0]!) : undefined;
  if (!name) return null;
  let i = 1;
  if (name === 'time') { if (words[i] === '-p') i++; }
  else if (name === 'nice') {
    if (words[i] === '-n') { if (!/^-?\d+$/.test(words[i + 1] ?? '')) return null; i += 2; }
    else if (/^-\d+$/.test(words[i] ?? '') || /^--adjustment=-?\d+$/.test(words[i] ?? '')) i++;
  } else {
    for (; i < words.length; i++) {
      const a = words[i]!;
      if (a === '--preserve-status' || a === '--foreground' || a === '-v' || a === '--verbose') continue;
      if (a === '-k' || a === '-s') { if (words[i + 1] === undefined) return null; i++; continue; }
      if (/^--(kill-after|signal)=\S+$/.test(a)) continue;
      break;
    }
    if (!DURATION.test(words[i] ?? '')) return null;
    i++;
  }
  const inner = words.slice(i);
  // an option left in front of the command means the shape was not understood
  return inner.length && !inner[0]!.startsWith('-') ? inner : null;
}

/**
 * Looks through a chain of wrappers (`timeout 5 nice cat f`) to the command at the end. Null when the first word is no wrapper; when a wrapper in the
 * chain is not understood, the words from that wrapper on (a wrapper is no program the classifier knows, so they judge as unknown).
 */
export function unwrapAll(words: readonly string[]): string[] | null {
  let cur: readonly string[] = words;
  let out: string[] | null = null;
  for (let depth = 0; depth < 8; depth++) {
    const inner = unwrapCommand(cur);
    if (!inner) return out;
    out = inner; cur = inner;
  }
  return null;
}
