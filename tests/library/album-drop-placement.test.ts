import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albumDropPlacement, type DropCollection } from '../../src/shared/library/album-drop-placement.js';

const tree: readonly DropCollection[] = [
  { id: 'folder', kind: 'folder', parentId: null },
  { id: 'a', kind: 'album', parentId: 'folder' },
  { id: 'b', kind: 'album', parentId: 'folder' },
  { id: 'loose', kind: 'album', parentId: null },
];

test('folder centers append inside; child edges select sibling placement (#1104)', () => {
  assert.deepEqual(albumDropPlacement(tree, 'loose', 'folder', 'inside'), { parentId: 'folder', position: 2 });
  assert.deepEqual(albumDropPlacement(tree, 'loose', 'b', 'before'), { parentId: 'folder', position: 1 });
  assert.deepEqual(albumDropPlacement(tree, 'loose', 'a', 'after'), { parentId: 'folder', position: 1 });
  assert.deepEqual(albumDropPlacement(tree, 'a', 'loose', 'before'), { parentId: null, position: 1 });
});

test('same-parent placement excludes the source before calculating its destination (#1104)', () => {
  assert.deepEqual(albumDropPlacement(tree, 'a', 'b', 'after'), { parentId: 'folder', position: 1 });
  assert.deepEqual(albumDropPlacement(tree, 'b', 'a', 'before'), { parentId: 'folder', position: 0 });
  assert.deepEqual(albumDropPlacement(tree, 'a', 'folder', 'inside'), { parentId: 'folder', position: 1 });
});

test('rejects absent/self/non-folder targets but leaves cycle policy to main (#1104)', () => {
  assert.equal(albumDropPlacement(tree, 'missing', 'folder', 'inside'), null);
  assert.equal(albumDropPlacement(tree, 'a', 'missing', 'before'), null);
  assert.equal(albumDropPlacement(tree, 'a', 'a', 'after'), null);
  assert.equal(albumDropPlacement(tree, 'a', 'b', 'inside'), null);
  assert.deepEqual(albumDropPlacement(tree, 'folder', 'a', 'before'), { parentId: 'folder', position: 0 });
});
