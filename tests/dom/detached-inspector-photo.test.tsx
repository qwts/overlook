import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDetachedInspectorPhoto } from '../../src/renderer/src/inspector/use-detached-inspector-photo.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

let root: Root | undefined;
const previous = window.overlook;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  (window as unknown as { overlook: unknown }).overlook = previous;
  document.body.replaceChildren();
});

function setup() {
  const pending: { id: string; resolve: (value: { photo: PhotoRecord | null }) => void }[] = [];
  let changed = (_event: { photoIds: string[] }): void => {};
  let subscriptions = 0;
  (window as unknown as { overlook: unknown }).overlook = {
    library: {
      get: ({ id }: { id: string }) => new Promise<{ photo: PhotoRecord | null }>((resolve) => pending.push({ id, resolve })),
      onChanged: (listener: typeof changed) => {
        changed = listener;
        subscriptions++;
        return () => {
          changed = () => {};
          subscriptions--;
        };
      },
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function View({ selection }: { selection: { photoId: string | null } }) {
    const photo = useDetachedInspectorPhoto(selection);
    return <output>{photo === null ? 'empty' : `${photo.id}:${photo.originalFailure ?? 'available'}`}</output>;
  }
  const render = (selection: { photoId: string | null }) => act(() => root?.render(<View selection={selection} />));
  const resolve = async (index: number, missing: boolean) => {
    const request = pending[index];
    assert.ok(request);
    // The hook only projects identity and the recovery status in this harness.
    const photo = { id: request.id, originalFailure: missing ? 'missing-original' : null } as PhotoRecord;
    await act(async () => {
      request.resolve({ photo });
      await Promise.resolve();
    });
  };
  return {
    container,
    pending,
    render,
    resolve,
    changed: (ids: string[]) => act(() => changed({ photoIds: ids })),
    subscriptions: () => subscriptions,
  };
}

test('detached Inspector refreshes recovery status and ignores superseded responses (#1101)', async () => {
  const w = setup();
  w.render({ photoId: 'first' });
  await w.resolve(0, true);
  assert.equal(w.container.textContent, 'first:missing-original');
  w.changed(['unrelated']);
  assert.equal(w.pending.length, 1);
  w.changed(['first']);
  w.changed(['first']);
  await w.resolve(2, false);
  await w.resolve(1, true);
  assert.equal(w.container.textContent, 'first:available');
  w.changed([]);
  assert.equal(w.pending.length, 4);
});

test('detached Inspector fences prior selection and unmounted reads (#1101)', async () => {
  const w = setup();
  w.render({ photoId: 'first' });
  w.render({ photoId: 'second' });
  await w.resolve(1, false);
  await w.resolve(0, true);
  assert.equal(w.container.textContent, 'second:available');
  w.changed(['second']);
  w.render({ photoId: null });
  await w.resolve(2, true);
  assert.equal(w.container.textContent, 'empty');
  assert.equal(w.subscriptions(), 0);
  w.render({ photoId: 'third' });
  act(() => root?.unmount());
  root = undefined;
  await w.resolve(3, true);
  assert.equal(w.subscriptions(), 0);
});
