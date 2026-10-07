/** The agent editor warning (design 4.4 H2) and the wiring of the GitHub settings page. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectorsShellWarning, storageLine } from '../src/shared/connectors-view.js';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('warning: connectors + full approval + a shell; a Claude agent always has a shell, a provider agent only with its VM on', () => {
  const w = (o: Partial<Parameters<typeof connectorsShellWarning>[0]>) => connectorsShellWarning({ connectors: true, approval: 'full', onProvider: false, vmOn: false, ...o });
  assert.match(w({})!, /shell commands and never asks/);
  assert.match(w({ onProvider: true, vmOn: true })!, /shell/);
  assert.equal(w({ onProvider: true, vmOn: false }), undefined, 'a provider agent without a VM has no shell');
  assert.equal(w({ approval: 'ask' }), undefined);
  assert.equal(w({ approval: 'auto-edits' }), undefined);
  assert.equal(w({ connectors: false }), undefined);
});

test('storage wording is plain for every state', () => {
  assert.match(storageLine('ok'), /encrypted/);
  assert.match(storageLine('memory-only'), /each time Legion starts/);
  assert.match(storageLine('sign-in-again'), /Sign in again/);
  assert.equal(storageLine('empty'), '');
});

test('the editor shows the warning and saves the opt-in; Settings has the GitHub page; the page shows the not-available state and the revoke link', () => {
  const editor = src('ui/src/components/AgentEditor.tsx');
  assert.match(editor, /connectorsShellWarning\(\{ connectors: github, approval, onProvider, vmOn \}\)/);
  assert.match(editor, /connectors: github \? \['github'\] : \[\]/);
  assert.match(src('ui/src/components/Settings.tsx'), /section === 'github' \? <GithubSection \/>/);
  const page = src('ui/src/connectors/GithubSection.tsx');
  assert.match(page, /Not available yet/);
  assert.match(page, /Removed here\. To revoke the grant at GitHub/);
  assert.match(page, /connectorConnect/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
});
