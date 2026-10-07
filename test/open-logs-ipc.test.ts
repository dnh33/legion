/** The Open folder IPC: the handler takes no path from the window, and the button only exists where the preload offers it. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8');
/** The parameter list of the ipcMain.handle('legion:open-logs', ...) callback. */
export function handlerParams(src: string): string[] | null {
  const m = /ipcMain\.handle\('legion:open-logs',\s*(?:async\s*)?\(([^)]*)\)/.exec(src);
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

describe('legion:open-logs', () => {
  it('the handler takes only the event, never a path, and opens join(dataDir(), "logs")', () => {
    const main = read('src', 'electron', 'main.ts');
    const params = handlerParams(main);
    assert.ok(params, 'handler found');
    assert.equal(params!.length, 1, `only the event: ${params!.join(', ')}`);
    assert.match(main, /const dir = join\(dataDir\(\), 'logs'\);[\s\S]{0,120}shell\.openPath\(dir\)/);
  });
  it('the guard rejects a handler that takes a path', () => {
    assert.equal(handlerParams("ipcMain.handle('legion:open-logs', async (e, p: string) => {})")!.length, 2);
  });
  it('preload exposes one argument-free function and the button hides without it', () => {
    assert.match(read('src', 'electron', 'preload.cjs'), /openLogsFolder\(\) \{\s*return ipcRenderer\.invoke\('legion:open-logs'\);/);
    assert.match(read('ui', 'src', 'logs', 'LogsSection.tsx'), /\{openLogsFolder && <button/);
  });
});
