/** HTTP routes of the comms bridge (bearer auth is enforced by the dispatcher). Thin adapter over CommsHub. */
import type { RoomStrategy } from '../../shared/comms.js';
import type { RouteAdder } from '../modules.js';
import { HttpError } from '../server.js';
import type { Ctx, Handler } from '../server.js';
import { CommsError } from './hub.js';
import type { CommsHub, PatchRoomInput } from './hub.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const STRATEGIES: RoomStrategy[] = ['mention', 'manager', 'round-robin', 'all'];

function body(c: Ctx): Record<string, unknown> {
  if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required');
  return c.body;
}
function optStr(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  return v;
}
function strList(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${field} must be an array of strings`);
  return v as string[];
}
function strategy(v: unknown): RoomStrategy | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !STRATEGIES.includes(v as RoomStrategy)) throw new HttpError(400, `strategy must be one of: ${STRATEGIES.join(', ')}`);
  return v as RoomStrategy;
}
function guards(v: unknown): PatchRoomInput['guards'] {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new HttpError(400, 'guards must be an object');
  return v as PatchRoomInput['guards']; // numeric ranges and unknown keys are validated by the hub
}

/** Maps hub errors onto HttpError so the dispatcher answers 400/404/409 instead of 500. */
const wrap = (h: Handler): Handler => async (c) => {
  try { return await h(c); } catch (e) {
    if (e instanceof CommsError) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function addCommsRoutes(add: RouteAdder, hub: CommsHub): void {
  // `search` is registered before `:id` so it is not captured as a room id.
  add('GET', '/api/rooms/search', wrap(({ url }) => {
    const q = url.searchParams.get('q');
    if (q === null || !q.trim()) throw new HttpError(400, 'q is required');
    return { q, ...hub.search(q) };
  }));
  add('GET', '/api/rooms', wrap(() => hub.listRooms()));
  add('POST', '/api/rooms', wrap((c) => {
    const b = body(c);
    if (typeof b.name !== 'string') throw new HttpError(400, 'name is required');
    const members = strList(b.members, 'members');
    if (!members) throw new HttpError(400, 'members is required');
    return hub.createRoom({
      name: b.name, members, strategy: strategy(b.strategy), lead: optStr(b.lead, 'lead'), guards: guards(b.guards),
    });
  }), 201);
  add('GET', '/api/rooms/:id', wrap(({ params }) => hub.roomWithMessages(params[0]!, 200)));
  add('PATCH', '/api/rooms/:id', wrap((c) => {
    const b = body(c);
    return hub.updateRoom(c.params[0]!, { name: optStr(b.name, 'name'), strategy: strategy(b.strategy), lead: optStr(b.lead, 'lead'), guards: guards(b.guards) });
  }));
  add('DELETE', '/api/rooms/:id', wrap(({ params }) => { hub.deleteRoom(params[0]!); return { ok: true }; }));
  add('POST', '/api/rooms/:id/members', wrap((c) => {
    const b = body(c);
    return hub.updateMembers(c.params[0]!, { add: strList(b.add, 'add'), remove: strList(b.remove, 'remove') });
  }));
  add('POST', '/api/rooms/:id/messages', wrap((c) => {
    const b = body(c);
    if (typeof b.text !== 'string') throw new HttpError(400, 'text is required');
    return hub.postHuman(c.params[0]!, b.text);
  }), 201);
  add('POST', '/api/rooms/:id/freeze', wrap(({ params }) => hub.freeze(params[0]!)));
  add('POST', '/api/rooms/:id/resume', wrap(({ params }) => hub.resume(params[0]!)));
  add('GET', '/api/rooms/:id/export', wrap(({ params, url, res }) => {
    const raw = url.searchParams.get('format') ?? 'md';
    if (raw !== 'md' && raw !== 'json') throw new HttpError(400, 'format must be md or json');
    const out = hub.exportRoom(params[0]!, raw);
    if (typeof out !== 'string') return out;
    // Markdown is written directly; the dispatcher leaves an already-sent response alone.
    const buf = Buffer.from(out, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
    return undefined;
  }));
}
