/** What the finder reads from one skill: its name, description, `when_to_use` and the headings of its SKILL.md. */
import { closeSync, openSync, readSync } from 'node:fs';
import type { CatalogEntry } from '../catalog.js';
import { THIRD_PARTY } from '../catalog.js';
import type { SkillSource } from '../discover.js';
import { parseFrontmatter } from '../../house/skills.js';
import { oneLine } from '../../kg/text.js';

export interface FinderDoc {
  id: string;
  name: string;
  description: string;
  /** The `when_to_use` frontmatter value, on one line. */
  whenToUse: string;
  /** Headings of levels 1 to 3 in the body, joined with spaces. */
  headings: string;
  source: SkillSource;
  thirdParty: boolean;
}

/** The most of a skill file the finder reads. */
export const MAX_READ_BYTES = 64 * 1024;
const MAX_WHEN_TO_USE = 1536;
const MAX_HEADINGS = 2000;

/** The frontmatter block: the text between the first two `---` lines. Same shape as the house parser's match. */
const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** Reads the first 64 KB of a file. Any error gives null. */
function defaultRead(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const n = readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Heading lines of levels 1 to 3, outside fenced code blocks, without the hash marks. */
function headingsOf(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^#{1,3}[ \t]+(.+?)\s*$/.exec(line);
    if (h) out.push(h[1]);
  }
  return oneLine(out.join(' ')).slice(0, MAX_HEADINGS).trimEnd();
}

/**
 * The finder's view of one skill. The catalog gives the name, description and source; the skill file (when there is one)
 * gives `when_to_use` and the headings. A file that cannot be read gives empty file fields. Built-ins have no file.
 */
export function docFromEntry(e: CatalogEntry, read: (path: string) => string | null = defaultRead): FinderDoc {
  let raw: string | null = null;
  if (e.path !== null) {
    try { raw = read(e.path); } catch { raw = null; }
  }
  const text = raw === null ? '' : raw.slice(0, MAX_READ_BYTES);
  const whenRaw = text === '' ? '' : (parseFrontmatter(text).when_to_use ?? '');
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    whenToUse: oneLine(whenRaw).slice(0, MAX_WHEN_TO_USE).trimEnd(),
    headings: headingsOf(text.replace(FRONTMATTER, '')),
    source: e.source,
    thirdParty: THIRD_PARTY.has(e.source),
  };
}
