import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathInside } from '../src/core/engine.js';

const win = process.platform === 'win32';

describe('pathInside folds the Windows spellings that name the same folder', () => {
  it('still answers the plain cases', () => {
    assert.equal(pathInside('/a/armory', '/a/armory/x'), true);
    assert.equal(pathInside('/a/armory', '/a/armory'), true);
    assert.equal(pathInside('/a/armory', '/a/armory-other/x'), false);
  });

  it('a trailing dot or space on a folder name is the same folder', { skip: !win }, () => {
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates.\\rules.json'), true);
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates \\rules.json'), true);
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates. .\\rules.json'), true);
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates.'), true);
    assert.equal(pathInside('C:\\data\\config.json', 'C:\\data\\config.json. '), true);
  });

  it('a dot in the middle of a segment is a different folder', { skip: !win }, () => {
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates.old\\rules.json'), false);
    assert.equal(pathInside('C:\\data\\gates', 'C:\\data\\gates-x\\rules.json'), false);
  });

  it('long-path and device prefixes name the same folder', { skip: !win }, () => {
    assert.equal(pathInside('C:\\data\\gates', '\\\\?\\C:\\data\\gates\\rules.json'), true);
    assert.equal(pathInside('C:\\data\\gates', '\\\\.\\C:\\data\\gates.\\rules.json'), true);
    assert.equal(pathInside('C:\\data\\gates', '\\\\localhost\\c$\\data\\gates\\rules.json'), true);
  });

  it('a folder above a protected one is still not inside it', { skip: !win }, () => {
    assert.equal(pathInside('C:\\work\\x', 'C:\\work\\x.\\proj'), true);
    assert.equal(pathInside('C:\\work\\x.\\proj', 'C:\\work\\x'), false);
  });
});
