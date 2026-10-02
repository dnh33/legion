/**
 * Redaction of a live text stream. A saved key can arrive split across chunks (down to one character each), so a filter that checks
 * each chunk alone would let it through. This holds back a tail of the stream (at least the longest secret plus a margin), finds
 * secrets in the whole held text (exact saved keys, and sk- shaped tokens, which may still be growing at the end), never cuts inside
 * one, and emits only text that has passed `redact`. `flush` releases the rest at the end of a turn.
 */
export const STREAM_MARGIN = 48;
/** An sk- shaped token: matches how scrubSecrets finds one, and is allowed to run to the end of the held text. */
const SK_SHAPE = /sk-[A-Za-z0-9_-]{8,}/g;

export interface StreamRedactor { push(chunk: string): void; flush(): void }

export function makeStreamRedactor(emit: (text: string) => void, redact: (s: string) => string, secrets: () => string[]): StreamRedactor {
  let held = '';
  const spans = (text: string, keys: string[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const k of keys) { if (k.length < 8) continue; for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) out.push([i, i + k.length]); }
    for (const m of text.matchAll(SK_SHAPE)) out.push([m.index!, m.index! + m[0].length]);
    return out;
  };
  return {
    push(chunk) {
      if (!chunk) return;
      held += chunk;
      const keys = secrets();
      const hold = Math.max(keys.reduce((n, k) => Math.max(n, k.length), 0), 16) + STREAM_MARGIN;
      let cut = held.length - hold;
      if (cut <= 0) return;
      // never cut inside a secret (or inside a token that may still be growing)
      for (let moved = true; moved;) {
        moved = false;
        for (const [a, b] of spans(held, keys)) if (a < cut && cut < b) { cut = a; moved = true; }
      }
      // a possible start of an exact key at the very end of what would be emitted stays held
      if (cut <= 0) return;
      const out = held.slice(0, cut);
      held = held.slice(cut);
      emit(redact(out));
    },
    flush() {
      if (!held) return;
      const out = held; held = '';
      emit(redact(out));
    },
  };
}
