import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createApplicationEventBus } from '../../src/main/application-event-bus.js';

describe('application event bus', () => {
  test('validates renderer events and isolates local library listeners', () => {
    const sent: { readonly name: string; readonly payload: unknown }[] = [];
    const calls: string[] = [];
    const bus = createApplicationEventBus((name, payload) => {
      sent.push({ name, payload });
      calls.push('renderer');
    });
    const unsubscribeThrowing = bus.onLibraryChanged(() => {
      calls.push('throwing');
      throw new Error('listener failure');
    });
    const unsubscribeHealthy = bus.onLibraryChanged(() => calls.push('healthy'));

    bus.libraryChanged({ photoIds: ['P1'], membership: 'library' });
    unsubscribeThrowing();
    unsubscribeHealthy();
    bus.libraryChanged({ photoIds: [] });
    bus.exportProgress({ done: 1, total: 2 });
    bus.photoKitProgress({ operation: 'import', phase: 'transferring', done: 1, total: 1 });
    bus.boardsReload({ boardId: 'B1' });

    assert.deepEqual(calls, ['renderer', 'throwing', 'healthy', 'renderer', 'renderer', 'renderer', 'renderer']);
    assert.deepEqual(
      sent.map(({ name }) => name),
      ['library:changed', 'library:changed', 'export:progress', 'photo-kit:progress', 'board:reload'],
    );
  });
});
