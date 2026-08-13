import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RecoveryExportReceipt } from '../../src/main/crypto/recovery-export-receipt.js';

describe('recovery export receipt (#882)', () => {
  test('is library-bound, single-use, and expires after ten minutes', () => {
    let now = 1_000;
    const receipt = new RecoveryExportReceipt(() => now);
    receipt.mark('library-a');
    assert.equal(receipt.has('library-b'), false);
    assert.equal(receipt.has('library-a'), true);

    receipt.mark('library-a');
    assert.equal(receipt.consume('library-a'), true);
    assert.equal(receipt.consume('library-a'), false);

    receipt.mark('library-a');
    now += 10 * 60 * 1_000 + 1;
    assert.equal(receipt.consume('library-a'), false);
  });
});
