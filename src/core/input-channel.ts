/**
 * The prompt of a Claude run, as a stream (SDK "streaming input mode"): the first message is the request, and a person
 * can add messages while the run works. The SDK reads them in order and answers each one after the current turn, in the
 * same conversation (docs: agent-sdk/streaming-vs-single-mode, "Queued messages ... process sequentially").
 * The run ends when the channel is closed, which the engine does once every message it pushed has had its answer.
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class InputChannel implements AsyncIterable<SDKUserMessage> {
  /** The first message's text, for logs and for test fakes that match on the request. */
  readonly initialText: string;
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiting: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  /** Messages pushed (the first included) whose answer has not arrived yet. */
  pending = 0;
  /** While set, the iterator yields nothing: the SDK writes a message to the CLI as soon as it reads it, so a held channel keeps the request back. */
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  /** `hold`: keep every message back until release() or close() (a plan-only run waits for its account check). */
  constructor(first: string, hold = false) {
    this.initialText = first;
    if (hold) this.gate = new Promise<void>((res) => { this.openGate = res; });
    this.push(first);
  }

  /** Lets the held messages through. A no-op when nothing is held. */
  release(): void { this.openGate?.(); this.openGate = undefined; }

  /** Adds a message; false once the channel is closed (the run is ending, so the caller must start a new one). */
  push(text: string): boolean {
    if (this.closed) return false;
    this.pending++;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false }); else this.queue.push(msg);
    return true;
  }

  /**
   * A result arrived. Returns true when none are left waiting. Claude Code can answer several sends with one result (a message
   * sent mid-turn is folded into that turn), so its own count of sends still queued wins when the result carries it
   * (`queued_turn_count`); counting one result per message is the fallback for producers without it.
   */
  answered(queued?: unknown): boolean {
    if (typeof queued === 'number') { this.pending = Math.max(0, queued); return this.pending === 0; }
    this.pending = Math.max(0, this.pending - 1);
    return this.pending === 0;
  }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const take = (): Promise<IteratorResult<SDKUserMessage>> => {
          const v = this.queue.shift();
          if (v) return Promise.resolve({ value: v, done: false });
          if (this.closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => this.waiting.push(res));
        };
        // a closed channel never delivers what was held
        if (this.gate && this.openGate) return this.gate.then(() => (this.closed ? { value: undefined, done: true } as IteratorResult<SDKUserMessage> : take()));
        return take();
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

/** The request text of a run's prompt, whether it is a plain string or a channel. For fakes and logs. */
export function initialPrompt(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof InputChannel) return p.initialText;
  return String((p as { initialText?: unknown } | null)?.initialText ?? '');
}
