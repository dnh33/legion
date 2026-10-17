/**
 * The note: a short list of skills that may fit the message. It is text the model reads, so the taint rule lives here.
 * Only the owner's own and built-in skills show a description. A third-party skill shows its id and nothing else.
 */
import { oneLine } from '../../kg/text.js';
import type { FinderDoc } from './doc.js';
import type { Ranked } from './rank.js';

const HEADER = 'Skills that may fit this request:';
const MAX_DESCRIPTION = 200;
const MAX_ID = 120;

function build(results: Ranked[], docs: Map<string, FinderDoc>, last: string): string | undefined {
  if (results.length === 0) return undefined;
  const lines = results.map((r) => {
    // One line per result, whatever the id holds.
    const id = oneLine(r.id).slice(0, MAX_ID).trimEnd();
    const doc = docs.get(r.id);
    // Fail closed: a skill with no doc shows as third-party, so no text of an unknown skill reaches the model.
    if (!doc || doc.thirdParty) return `- ${id} (third-party)`;
    const description = oneLine(doc.description).slice(0, MAX_DESCRIPTION).trimEnd();
    return description ? `- ${id}: ${description}` : `- ${id}`;
  });
  return [HEADER, ...lines, last].join('\n');
}

/** The note for the Claude path, which uses the Skill tool. */
export function buildNote(results: Ranked[], docs: Map<string, FinderDoc>): string | undefined {
  return build(results, docs, 'Load one with the Skill tool if it applies.');
}

/** The note for the provider path, which uses armory_skill. */
export function buildProviderNote(results: Ranked[], docs: Map<string, FinderDoc>): string | undefined {
  return build(results, docs, 'Load one with armory_skill if it applies.');
}
