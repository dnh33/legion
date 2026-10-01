/** In-process event bus. */
import { EventEmitter } from 'node:events';
import type { LegionEvent } from '../shared/types.js';

export class EventBus {
  private ee = new EventEmitter();
  constructor() { this.ee.setMaxListeners(100); }
  emit(ev: LegionEvent): void { this.ee.emit('event', ev); }
  /** Returns an unsubscribe function. */
  on(fn: (ev: LegionEvent) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}
