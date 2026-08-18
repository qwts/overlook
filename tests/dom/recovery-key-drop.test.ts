import assert from 'node:assert/strict';
import { test } from 'node:test';

import { admitRecoveryKeyDrop } from '../../src/renderer/src/recovery-key-drop.js';

function files(...names: string[]): readonly File[] {
  return names.map((name) => new File(['fixture'], name, { type: 'application/octet-stream' }));
}

test('recovery-key drop admits exactly one local .key file (#480)', () => {
  const result = admitRecoveryKeyDrop(files('overlook-recovery.key'), (file) => `/Users/ansel/Desktop/${file.name}`);
  assert.deepEqual(result, { path: '/Users/ansel/Desktop/overlook-recovery.key', reason: null });

  const uppercase = admitRecoveryKeyDrop(files('OVERLOOK-RECOVERY.KEY'), (file) => `/Users/ansel/Desktop/${file.name}`);
  assert.deepEqual(uppercase, { path: '/Users/ansel/Desktop/OVERLOOK-RECOVERY.KEY', reason: null });
});

test('recovery-key drop rejects empty, multiple, and wrong-type selections (#480)', () => {
  const resolve = (file: File): string => `/Users/ansel/Desktop/${file.name}`;
  assert.deepEqual(admitRecoveryKeyDrop(files(), resolve), { path: null, reason: 'empty' });
  assert.deepEqual(admitRecoveryKeyDrop(files('first.key', 'second.key'), resolve), { path: null, reason: 'multiple' });
  assert.deepEqual(admitRecoveryKeyDrop(files('notes.txt'), resolve), { path: null, reason: 'wrong-type' });
});

test('recovery-key drop rejects a pathless or unresolvable sandbox file (#480)', () => {
  assert.deepEqual(
    admitRecoveryKeyDrop(files('overlook-recovery.key'), () => ''),
    { path: null, reason: 'unavailable' },
  );
  assert.deepEqual(
    admitRecoveryKeyDrop(files('overlook-recovery.key'), () => {
      throw new Error('path unavailable');
    }),
    { path: null, reason: 'unavailable' },
  );
});
