import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { GATES_DIGEST_HEADER } from '../../shared/gates-registry.js';

/** A change that loosens a gate comes from the Legion app's main process after its own confirmation dialog, never the window and never a token client. */
export function requireNative(c: Ctx, o: { nativeSecret?: string }): void {
  if (!o.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
  const given = (c.req.headers as Record<string, string | string[] | undefined>)[NATIVE_HEADER];
  if (typeof given !== 'string' || !safeEqual(given, o.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: a change that loosens a gate comes only from the app after its confirmation dialog');
}

/**
 * The app confirmed one exact change: its digest rides with the request, and the core refuses a change that would give different settings
 * (a file swapped, or another edit landed, while the dialog was open). A loosening must carry it; a change that does not loosen needs it only if sent.
 */
export function requireDigest(c: Ctx, expected: () => string, required: boolean): void {
  const given = (c.req.headers as Record<string, string | string[] | undefined>)[GATES_DIGEST_HEADER];
  const want = expected(); // first, so a body that is not valid gets its own 400
  if (typeof given !== 'string') { if (required) throw new HttpError(409, 'The change differs from what you confirmed'); return; }
  if (!safeEqual(given, want)) throw new HttpError(409, 'The change differs from what you confirmed');
}
