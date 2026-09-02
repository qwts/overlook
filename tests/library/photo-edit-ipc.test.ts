import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ActivityDraft, ActivityFacade } from '../../src/main/activity/activity-publication.js';
import { registerPhotoEditHandlersWith } from '../../src/main/library/photo-edit-ipc.js';
import type { PhotoEditService } from '../../src/main/library/photo-edit-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import { fakeRegistrar, INVALID_REQUEST, withQuietConsole } from '../ipc/fake-registrar.js';

// #493 / ADR-0031 §2 + §7: a mutation that advances the head records one
// `photo.edited` event and owes the backup a manifest generation; a no-op
// save records nothing and owes nothing.

const EMPTY = { photoId: 'P1', head: null, history: [] };

function result(changed: boolean, derivatives: 'regenerated' | 'failed' | 'deferred' | 'unchanged') {
  return { ...EMPTY, changed, derivatives, pendingCount: 0 };
}

describe('photo edit IPC adapters (#493)', () => {
  test('admits every channel, publishes advanced heads to activity, and owes the manifest only on change', async () => {
    const { registrar, invoke, channels: registered } = fakeRegistrar();
    let admitted = 0;
    let manifestChanged = 0;
    const drafts: (ActivityDraft | undefined)[] = [];
    const activity = {
      recordMutation: <T>(mutation: () => T, draft: (value: T) => ActivityDraft | undefined) => {
        const value = mutation();
        drafts.push(draft(value));
        return value;
      },
    } as unknown as ActivityFacade;
    const service = {
      head: () => EMPTY,
      save: (_photoId: string, operations: readonly unknown[]) => Promise.resolve(result(operations.length > 0, 'regenerated')),
      reset: () => Promise.resolve(result(true, 'failed')),
      revert: () => Promise.resolve(result(true, 'deferred')),
    } as unknown as PhotoEditService;
    registerPhotoEditHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      () => activity,
      () => {
        manifestChanged += 1;
      },
    );
    assert.equal(registered().length, 4);

    assert.deepEqual(await invoke(channels.photoEditHead.name, { photoId: 'P1' }), EMPTY);
    const noop = (await invoke(channels.photoEditSave.name, { photoId: 'P1', operations: [] })) as { changed: boolean };
    assert.equal(noop.changed, false);
    assert.equal(drafts.length, 0);
    assert.equal(manifestChanged, 0);

    const saved = (await invoke(channels.photoEditSave.name, {
      photoId: 'P1',
      operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
    })) as {
      changed: boolean;
    };
    assert.equal(saved.changed, true);
    assert.deepEqual(drafts[0], {
      eventType: 'photo.edited',
      entityIds: ['P1'],
      outcome: 'succeeded',
      payload: { kind: 'save', revisionId: null, operations: 0, derivatives: 'regenerated' },
    });
    await invoke(channels.photoEditReset.name, { photoId: 'P1' });
    assert.equal(drafts[1]?.outcome, 'partial');
    assert.equal(drafts[1]?.payload?.['kind'], 'reset');
    await invoke(channels.photoEditRevert.name, { photoId: 'P1', revisionId: 'R1' });
    assert.equal(drafts[2]?.payload?.['kind'], 'revert');
    assert.equal(manifestChanged, 3);
    assert.equal(admitted, 5);
  });

  test('runs without activity or manifest hooks and refuses an unknown operation before admitting', async () => {
    const { registrar, invoke } = fakeRegistrar();
    let admitted = 0;
    const service = { save: () => Promise.resolve(result(true, 'regenerated')) } as unknown as PhotoEditService;
    registerPhotoEditHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
    );
    const saved = (await invoke(channels.photoEditSave.name, {
      photoId: 'P1',
      operations: [{ type: 'flip', version: 1, axis: 'horizontal' }],
    })) as { changed: boolean };
    assert.equal(saved.changed, true);
    const logged = await withQuietConsole(async () => {
      assert.deepEqual(
        await invoke(channels.photoEditSave.name, { photoId: 'P1', operations: [{ type: 'sharpen', version: 1 }] }),
        INVALID_REQUEST,
      );
    });
    assert.equal(admitted, 1);
    assert.equal(logged.length, 1);
  });
});
