/** Which provider cards Settings shows and how each card's key field reads. Pure, so the core suite can check it. */
import type { ProviderView } from '../../../src/shared/providers-view.js';

/** Every provider the core lists: a preset that is off still gets its card, so the person can switch it on. */
export const visibleCards = (providers: readonly ProviderView[]): ProviderView[] => [...providers];

/**
 * The key field. A provider that needs a key always shows it. A local one shows it too, marked optional, because a server
 * (vLLM, or Ollama behind a proxy) may have been started with a key and Legion must be able to send it.
 */
export function keyFieldFor(p: Pick<ProviderView, 'needsKey' | 'keySet'>): { show: boolean; label: string; optional: boolean } {
  return p.needsKey
    ? { show: true, label: 'API key', optional: false }
    : { show: true, label: 'API key (only if your server asks for one)', optional: true };
}
