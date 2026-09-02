import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EDIT_REVISION_FORMAT_VERSION,
  IDENTITY_TRANSFORM,
  canonicalJson,
  carryCrop,
  editOperationSchema,
  foldOperations,
  isIdentityTransform,
  operationsFromTransform,
  parseEditRevision,
  transformsEqual,
  type EditOperation,
  type EditTransform,
} from '../../src/shared/library/edit-revision.js';

// #493 / ADR-0031 §2: an edit revision is an immutable, versioned document
// whose operations fold into one transform. Documents this build cannot
// evaluate are preserved and reported, never rewritten or silently applied.

const ID = '01J8ED00000000000000000001';
const PARENT = '01J8ED00000000000000000000';
const AT = '2026-09-01T10:00:00.000Z';

const rotate = (quarterTurns: 1 | 2 | 3): EditOperation => ({ type: 'rotate', version: 1, quarterTurns });
const flip = (axis: 'horizontal' | 'vertical'): EditOperation => ({ type: 'flip', version: 1, axis });
const crop = (left: number, top: number, width: number, height: number): EditOperation => ({
  type: 'crop',
  version: 1,
  left,
  top,
  width,
  height,
});

function document(operations: readonly unknown[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: EDIT_REVISION_FORMAT_VERSION,
    id: ID,
    parentId: PARENT,
    operations,
    author: { product: 'overlook', version: '1.2.3' },
    createdAt: AT,
    importedFrom: null,
    ...patch,
  };
}

const approx = (actual: EditTransform['crop'], expected: EditTransform['crop']): void => {
  assert.ok(actual !== null && expected !== null);
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${String(actual[key])} vs ${String(expected[key])}`);
  }
};

describe('edit revision documents (#493)', () => {
  test('a v1 document parses: operations validated, transform folded, nothing unsupported', () => {
    const parsed = parseEditRevision(document([rotate(1), flip('horizontal'), crop(0.1, 0.2, 0.5, 0.5)]));
    assert.ok(parsed.ok);
    assert.equal(parsed.unsupported, null);
    assert.equal(parsed.operations.length, 3);
    assert.equal(parsed.document.parentId, PARENT);
  });

  test('a newer document format fails closed with a reason', () => {
    const parsed = parseEditRevision(document([], { version: 2 }));
    assert.ok(!parsed.ok);
    assert.match(parsed.reason, /newer/u);
  });

  test('an operation type or version this build does not know is reported unsupported, not dropped', () => {
    const parsed = parseEditRevision(document([rotate(1), { type: 'curve', version: 3, points: [] }]));
    assert.ok(parsed.ok);
    assert.notEqual(parsed.unsupported, null);
    const newerVersion = parseEditRevision(document([{ type: 'rotate', version: 2, quarterTurns: 1 }]));
    assert.ok(newerVersion.ok);
    assert.notEqual(newerVersion.unsupported, null);
  });

  test('malformed documents are rejected: bad id, bad timestamp, extra keys, invalid crop', () => {
    assert.ok(!parseEditRevision(document([], { id: 'not-a-ulid' })).ok);
    assert.ok(!parseEditRevision(document([], { createdAt: '2026-09-01' })).ok);
    assert.ok(!parseEditRevision(document([], { extra: true })).ok);
    assert.ok(!parseEditRevision('nope').ok);
    assert.throws(() => editOperationSchema.parse(crop(0.6, 0, 0.5, 1)), /exceeds/u);
    assert.throws(() => editOperationSchema.parse({ type: 'rotate', version: 1, quarterTurns: 4 }));
  });

  test('canonical JSON is key-sorted and stable, so equal stacks hash equal', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }] }), '{"a":[{"c":"x","d":null}],"b":1}');
    assert.equal(canonicalJson([rotate(1)]), canonicalJson([{ quarterTurns: 1, version: 1, type: 'rotate' }]));
  });

  test('folding: rotations accumulate, flips invert later turns, two vertical flips cancel', () => {
    assert.deepEqual(foldOperations([rotate(1), rotate(1)]), { quarterTurns: 2, flipped: false, crop: null });
    assert.deepEqual(foldOperations([rotate(3), rotate(1)]), IDENTITY_TRANSFORM);
    // A horizontal flip then a visual clockwise turn is a counterclockwise turn in source space.
    assert.deepEqual(foldOperations([flip('horizontal'), rotate(1)]), { quarterTurns: 3, flipped: true, crop: null });
    assert.deepEqual(foldOperations([flip('vertical'), flip('vertical')]), IDENTITY_TRANSFORM);
    assert.deepEqual(foldOperations([flip('vertical')]), { quarterTurns: 2, flipped: true, crop: null });
  });

  test('folding: a crop is carried through a later turn and a nested crop narrows', () => {
    const turned = foldOperations([crop(0, 0, 0.5, 0.5), rotate(1)]);
    // The top-left quarter lands top-right after a clockwise quarter turn.
    approx(turned.crop, { left: 0.5, top: 0, width: 0.5, height: 0.5 });
    const nested = foldOperations([crop(0.2, 0.2, 0.5, 0.5), crop(0.5, 0.5, 0.5, 0.5)]);
    approx(nested.crop, { left: 0.45, top: 0.45, width: 0.25, height: 0.25 });
    const mirrored = foldOperations([crop(0, 0, 0.25, 1), flip('horizontal')]);
    approx(mirrored.crop, { left: 0.75, top: 0, width: 0.25, height: 1 });
  });

  test('carryCrop matches the fold for every single rotate/flip', () => {
    const framed = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
    for (const operation of [rotate(1), rotate(2), rotate(3), flip('horizontal'), flip('vertical')] as const) {
      if (operation.type === 'crop') continue;
      const folded = foldOperations([crop(framed.left, framed.top, framed.width, framed.height), operation]);
      approx(carryCrop(framed, operation), folded.crop);
    }
  });

  test('operationsFromTransform is the minimal stack that folds back to the transform', () => {
    const transform: EditTransform = { quarterTurns: 3, flipped: true, crop: { left: 0.1, top: 0.1, width: 0.5, height: 0.5 } };
    const operations = operationsFromTransform(transform);
    assert.deepEqual(
      operations.map((operation) => operation.type),
      ['rotate', 'flip', 'crop'],
    );
    assert.ok(transformsEqual(foldOperations(operations), transform));
    assert.deepEqual(operationsFromTransform(IDENTITY_TRANSFORM), []);
    assert.ok(isIdentityTransform(foldOperations([])));
    assert.ok(!isIdentityTransform(transform));
  });
});
