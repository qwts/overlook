import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { editsXmpAttributes, exifOrientation, parseEditsXmp, xmpPacket } from '../../src/main/export/edit-xmp.js';
import { authoredMetadataXmp } from '../../src/main/export/export-engine.js';
import { IDENTITY_TRANSFORM, type EditTransform } from '../../src/shared/library/edit-revision.js';

// #497 / ADR-0031 §4: XMP is the writable interoperability target for the
// operations covered by reviewed round-trip fixtures. These are the fixtures:
// every one of the eight orientations and the crop rectangle come back from
// the packet exactly as written; an identity stack writes nothing.

const ORIENTATIONS: readonly [EditTransform['quarterTurns'], boolean, number][] = [
  [0, false, 1],
  [1, false, 6],
  [2, false, 3],
  [3, false, 8],
  [0, true, 2],
  [1, true, 5],
  [2, true, 4],
  [3, true, 7],
];

describe('edits as XMP (#497)', () => {
  test('rotate/flip map onto the eight EXIF orientations and back', () => {
    for (const [quarterTurns, flipped, expected] of ORIENTATIONS) {
      const transform: EditTransform = { quarterTurns, flipped, crop: null };
      assert.equal(exifOrientation(transform), expected, `${String(quarterTurns)} turns, flipped ${String(flipped)}`);
      if (expected === 1) continue;
      const xml = xmpPacket(editsXmpAttributes(transform), '').toString('utf8');
      assert.ok(xml.includes(`tiff:Orientation="${String(expected)}"`));
      assert.deepEqual(parseEditsXmp(xml), transform);
    }
  });

  test('the crop rectangle round-trips as Camera Raw crop edges in the oriented frame', () => {
    const transform: EditTransform = { quarterTurns: 1, flipped: false, crop: { left: 0.1, top: 0.2, width: 0.5, height: 0.25 } };
    const xml = xmpPacket(editsXmpAttributes(transform), '').toString('utf8');
    assert.ok(xml.includes('crs:HasCrop="True"'));
    assert.ok(xml.includes('crs:CropLeft="0.100000"'));
    assert.ok(xml.includes('crs:CropRight="0.600000"'));
    assert.ok(xml.includes('crs:CropBottom="0.450000"'));
    const parsed = parseEditsXmp(xml);
    assert.ok(parsed);
    assert.equal(parsed.quarterTurns, 1);
    assert.ok(parsed.crop);
    assert.ok(Math.abs(parsed.crop.left - 0.1) < 1e-6);
    assert.ok(Math.abs(parsed.crop.width - 0.5) < 1e-6);
    assert.ok(Math.abs(parsed.crop.height - 0.25) < 1e-6);
  });

  test('an identity stack writes no edit attributes and reads as no edit', () => {
    assert.equal(editsXmpAttributes(IDENTITY_TRANSFORM), '');
    assert.equal(parseEditsXmp(xmpPacket('', '').toString('utf8')), null);
    assert.equal(authoredMetadataXmp(null, IDENTITY_TRANSFORM), null, 'nothing to say, no sidecar');
  });

  test('the sidecar carries edits with or without authored metadata', () => {
    const rotated: EditTransform = { quarterTurns: 2, flipped: false, crop: null };
    const editsOnly = authoredMetadataXmp(null, rotated)?.toString('utf8') ?? '';
    assert.ok(editsOnly.includes('tiff:Orientation="3"'));
    assert.equal(editsOnly.includes('<dc:title>'), false);
    assert.deepEqual(parseEditsXmp(editsOnly), rotated);
  });
});
