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

  constructor(first: string) {
    this.initialText = first;
    this.push(first);
  }

  /** Adds a message; false once the channel is closed (the run is ending, so the caller must start a new one). */
  push(text: string): boolean {
    if (this.closed) return false;
    this.pending++;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false }); else this.queue.push(msg);
    return true;
  }

  /** One message got its answer (a result arrived). Returns true when none are left waiting. */
  answered(): boolean {
    this.pending = Math.max(0, this.pending - 1);
    return this.pending === 0;
  }

  get isClosed(): boolean { return this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.queue.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.waiting.push(res));
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
