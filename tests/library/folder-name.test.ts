import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { describeFolderNameObjection, objectToFolderName, type FolderNameObjection } from '../../src/shared/library/folder-name.js';

// #686: a library folder roams across volumes and operating systems, so a
// name is valid only when every platform the disk might visit accepts it.

describe('library folder-name validation (#686)', () => {
  test('accepts ordinary cross-platform names', () => {
    for (const name of ['My Library', 'Photos 2026', 'café-fotos', '写真', 'a', 'library.backup', 'CONCERT', 'nulled', '.hidden']) {
      assert.equal(objectToFolderName(name), null, `"${name}" is valid`);
    }
  });

  test('refuses each objection class', () => {
    const cases: readonly (readonly [string, FolderNameObjection])[] = [
      ['', 'empty'],
      ['.', 'dot-name'],
      ['..', 'dot-name'],
      ['a/b', 'separator'],
      ['a\\b', 'separator'],
      ['a:b', 'forbidden-character'],
      ['a*b', 'forbidden-character'],
      ['a?b', 'forbidden-character'],
      ['a<b>', 'forbidden-character'],
      ['a|b', 'forbidden-character'],
      ['a"b', 'forbidden-character'],
      ['a\u0000b', 'forbidden-character'],
      ['a\u001fb', 'forbidden-character'],
      ['CON', 'reserved-name'],
      ['con', 'reserved-name'],
      ['NUL.txt', 'reserved-name'],
      ['com7', 'reserved-name'],
      ['LPT1.photos', 'reserved-name'],
      [' leading', 'leading-space'],
      ['trailing ', 'trailing-dot-or-space'],
      ['trailing.', 'trailing-dot-or-space'],
      ['x'.repeat(256), 'too-long'],
      // 100 four-byte astral characters = 400 UTF-8 bytes.
      ['\u{1F4F7}'.repeat(100), 'too-long'],
    ];
    for (const [name, expected] of cases) {
      assert.equal(objectToFolderName(name), expected, `"${name.slice(0, 20)}" → ${expected}`);
    }
  });

  test('255 bytes exactly is accepted', () => {
    assert.equal(objectToFolderName('x'.repeat(255)), null);
  });

  test('every objection has a human-readable description', () => {
    const objections: readonly FolderNameObjection[] = [
      'empty',
      'dot-name',
      'separator',
      'forbidden-character',
      'reserved-name',
      'leading-space',
      'trailing-dot-or-space',
      'too-long',
    ];
    for (const objection of objections) {
      assert.ok(describeFolderNameObjection(objection).length > 0);
    }
  });
});
