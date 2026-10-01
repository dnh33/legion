/**
 * kg_capture templates: five kinds of durable note, each with required fields rendered under fixed headings, so a
 * captured note always has the same shape (and a half-filled one is refused with the list of what is missing).
 */
import { KgError } from './types.js';

export const CAPTURE_KINDS = ['decision', 'mistake', 'pattern', 'project', 'idea'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

interface FieldSpec { key: string; heading: string; list?: boolean }

export const CAPTURE_TEMPLATES: Record<CaptureKind, FieldSpec[]> = {
  decision: [
    { key: 'chose', heading: 'Chose' }, { key: 'why', heading: 'Why' },
    { key: 'rejected', heading: 'Rejected', list: true }, { key: 'revisitIf', heading: 'Revisit if' },
  ],
  mistake: [
    { key: 'what', heading: 'What happened' }, { key: 'rootCause', heading: 'Root cause' }, { key: 'fix', heading: 'Fix' },
    { key: 'lesson', heading: 'Lesson' }, { key: 'prevents', heading: 'Prevents' },
  ],
  pattern: [{ key: 'when', heading: 'When' }, { key: 'do', heading: 'Do' }, { key: 'because', heading: 'Because' }],
  project: [{ key: 'whereThingsAre', heading: 'Where things are', list: true }, { key: 'open', heading: 'Open', list: true }],
  idea: [{ key: 'pitch', heading: 'Pitch' }, { key: 'status', heading: 'Status' }, { key: 'score', heading: 'Score' }],
};

export const CAPTURE_HELP = CAPTURE_KINDS.map((k) => `${k}: ${CAPTURE_TEMPLATES[k].map((f) => f.key + (f.list ? '[]' : '')).join(', ')}`).join('; ');

const MAX_SCALAR = 2_000;
const MAX_ITEM = 500;
const MAX_ITEMS = 20;

/** Renders the fixed-heading body, or throws one error naming every missing or malformed field. Unknown fields are reported, not stored. */
export function renderCapture(kind: CaptureKind, fields: Record<string, unknown>): { body: string; ignored: string[] } {
  const spec = CAPTURE_TEMPLATES[kind];
  if (!spec) throw new KgError('invalid', `Unknown kind "${String(kind)}". Use ${CAPTURE_KINDS.join(', ')}.`);
  const problems: string[] = [];
  const parts: string[] = [];
  for (const f of spec) {
    const v = fields[f.key];
    if (f.list) {
      const items = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : undefined;
      if (!items) { problems.push(`${f.key} (a list of strings; may be empty)`); continue; }
      const clean = items.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
      if (clean.length !== items.length) { problems.push(`${f.key} (every item must be non-empty text)`); continue; }
      if (clean.length > MAX_ITEMS || clean.some((x) => x.length > MAX_ITEM)) { problems.push(`${f.key} (at most ${MAX_ITEMS} items of ${MAX_ITEM} chars)`); continue; }
      parts.push(`## ${f.heading}\n${clean.length ? clean.map((x) => `- ${x.replace(/\s*\n\s*/g, ' ')}`).join('\n') : '- (none)'}`);
    } else {
      const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
      if (!text) { problems.push(f.key); continue; }
      if (text.length > MAX_SCALAR) { problems.push(`${f.key} (longer than ${MAX_SCALAR} chars)`); continue; }
      parts.push(`## ${f.heading}\n${text}`);
    }
  }
  if (problems.length) {
    throw new KgError('invalid', `A ${kind} needs: ${spec.map((f) => f.key + (f.list ? '[]' : '')).join(', ')}. Missing or malformed: ${problems.join('; ')}. Nothing was saved.`);
  }
  const known = new Set(spec.map((f) => f.key));
  return { body: parts.join('\n\n'), ignored: Object.keys(fields).filter((k) => !known.has(k)) };
}
