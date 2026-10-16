/**
 * Loads of one thing per key (a project's board), one at a time. A request that arrives while a load is running is never answered by that
 * load: the data it carries may predate the request (a proposal made a moment ago, a board event that fired mid-load). It waits for ONE
 * trailing load that starts after the running one ends, and every request made meanwhile shares it (unless it asks to `join` the running one). `told` says the flight already showed
 * the error, so a caller does not show a second one: at most one error toast per failed flight, whoever asked.
 */
export interface FlightResult { ok: boolean; told: boolean }
interface Slot { loud: boolean; promise: Promise<FlightResult>; start: () => void }

export function createFlights(run: (key: string) => Promise<void>, tell: (e: unknown) => void): { load(key: string, opts?: { quiet?: boolean; join?: boolean }): Promise<FlightResult> } {
  const running = new Map<string, Slot>();
  const waiting = new Map<string, Slot>();
  function make(key: string): Slot {
    const slot = { loud: false } as Slot;
    slot.promise = new Promise<FlightResult>((resolve) => {
      slot.start = () => {
        running.set(key, slot);
        void (async () => {
          let result: FlightResult = { ok: false, told: false };
          try {
            try { await run(key); result = { ok: true, told: false }; } catch (e) { result = { ok: false, told: slot.loud }; if (slot.loud) tell(e); }
          } catch { /* a failing `tell` (the toast) must not break the flight */ } finally {
            running.delete(key);
            const next = waiting.get(key);
            if (next) { waiting.delete(key); next.start(); }
            resolve(result);
          }
        })();
      };
    });
    return slot;
  }
  return {
    load(key, opts = {}) {
      // `join`: nothing is stale (no data yet), so share the flight that is running instead of queuing a reload after it
      let slot = waiting.get(key) ?? (opts.join ? running.get(key) : undefined);
      if (!slot) {
        slot = make(key);
        if (running.has(key)) waiting.set(key, slot);
        else slot.start();
      }
      if (!opts.quiet) slot.loud = true;
      return slot.promise;
    },
  };
}
