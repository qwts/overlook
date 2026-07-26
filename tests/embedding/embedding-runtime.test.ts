import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { executionProviders } from '../../src/main/embedding/embedding-runtime.js';

describe('embedding execution-provider fallback', () => {
  test('probes each native accelerator before the required CPU floor', () => {
    assert.deepEqual(executionProviders('darwin'), ['coreml', 'cpu']);
    assert.deepEqual(executionProviders('win32'), ['dml', 'cpu']);
    assert.deepEqual(executionProviders('linux'), ['cpu']);
  });
});
