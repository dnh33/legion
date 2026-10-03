/**
 * Registry of the built-in painted busts. The agent id IS the bot name (zealot, builder, scout, ...).
 * Art json is loaded on demand as a raw string and parsed only when a bust is first shown, so the
 * 12 muster busts (about 1.3 MB of paint) are not parsed up front. (The UI ships as one IIFE bundle,
 * so the bytes are in the bundle; what is lazy is the JSON.parse and the engine instance.)
 */
import type { MascotData, Persona } from './engine.js';
import relicData from './data/relic.json';

const personaFiles = import.meta.glob('./personas/*.json', { eager: true, import: 'default' }) as Record<string, Persona>;
const personas: Record<string, Persona> = {};
for (const [k, v] of Object.entries(personaFiles)) personas[/\/([^/]+)\.json$/.exec(k)![1]] = v;

type RawLoader = () => Promise<{ default: string }>;
const loaders: Record<string, RawLoader> = {
  archivist: () => import('./data/archivist.json?raw'),
  assayer: () => import('./data/assayer.json?raw'),
  builder: () => import('./data/builder.json?raw'),
  exorcist: () => import('./data/exorcist.json?raw'),
  forgemaster: () => import('./data/forgemaster.json?raw'),
  herald: () => import('./data/herald.json?raw'),
  inquisitor: () => import('./data/inquisitor.json?raw'),
  preceptor: () => import('./data/preceptor.json?raw'),
  scout: () => import('./data/scout.json?raw'),
  scribe: () => import('./data/scribe.json?raw'),
  sculptor: () => import('./data/sculptor.json?raw'),
  sentinel: () => import('./data/sentinel.json?raw'),
};

/** Agent ids that have a painted bust. */
export const hasBust = (id: string) => id === 'zealot' || id in loaders;

export interface LoadedBust { data: MascotData; persona: Persona }
const cache = new Map<string, Promise<LoadedBust>>();

export function loadBust(id: string): Promise<LoadedBust> {
  let p = cache.get(id);
  if (!p) {
    const persona = personas[id];
    if (!persona) return Promise.reject(new Error(`no persona for ${id}`));
    p = id === 'zealot'
      ? Promise.resolve({ data: relicData as MascotData, persona })
      : loaders[id]().then((m) => ({ data: JSON.parse(m.default) as MascotData, persona }));
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}
