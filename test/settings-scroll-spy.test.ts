/**
 * The project settings side menu follows the sections that are on the page NOW. "How agents ask" draws nothing until its settings arrive, so a
 * snapshot taken at mount missed it and the menu stayed on "Members" while "How agents ask" was on screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickSection } from '../ui/src/projects/page/settingsLogic.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

test('pickSection: the last section whose top reached the line, the first before any, the last at the bottom', () => {
  const secs = [{ id: 'general', top: 100 }, { id: 'members', top: 300 }, { id: 'ask', top: 500 }, { id: 'away', top: 900 }];
  assert.equal(pickSection(secs, 24, false), 'general');
  assert.equal(pickSection(secs, 350, false), 'members');
  assert.equal(pickSection(secs, 520, false), 'ask', 'a section that appeared late is picked like any other');
  assert.equal(pickSection(secs, 520, true), 'away', 'at the very bottom the last section');
  assert.equal(pickSection([{ id: 'general', top: 500 }], 24, false), 'general');
});

test('SettingsTab reads the sections inside the scroll handler, not once at mount', () => {
  const src = readFileSync(join(REPO, 'ui', 'src', 'projects', 'page', 'SettingsTab.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const handler = /const on = \(\): void => \{([\s\S]*?)\n    \};/.exec(src)?.[1] ?? '';
  assert.match(handler, /querySelectorAll<HTMLElement>\('\[data-sec\]'\)/, 'the query is in the handler');
  assert.doesNotMatch(src.slice(0, src.indexOf('const on =')).split('scroll-spy')[1] ?? '', /querySelectorAll/, 'and not above it');
});
