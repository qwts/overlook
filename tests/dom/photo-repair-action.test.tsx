import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { PhotoRepairAction } from '../../src/renderer/src/inspector/photo-repair-action.js';
import type { RepairablePhoto } from '../../src/shared/commands/photo-repair.js';
import type { PhotoRepairResult } from '../../src/shared/ipc/photo-repair-channels.js';

const photo: RepairablePhoto = {
  id: 'broken',
  fileKind: 'jpeg',
  deletedAt: null,
  locked: false,
  syncState: 'local',
  previewFailure: 'corrupt',
  dimensionStatus: 'verified',
};
let root: Root | undefined;
const original = Reflect.get(window, 'overlook') as unknown;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  Reflect.set(window, 'overlook', original);
  document.body.replaceChildren();
});

test('Inspector repair is bounded to one request and failure remains retryable (#1098)', async () => {
  let finish: ((value: PhotoRepairResult) => void) | undefined;
  const requests: string[] = [];
  Reflect.set(window, 'overlook', {
    library: {
      repairPhoto: ({ photoId }: { photoId: string }) => {
        requests.push(photoId);
        return new Promise<PhotoRepairResult>((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <PhotoRepairAction photo={photo} />
      </IntlProvider>,
    ),
  );
  const button = container.querySelector('button');
  assert.ok(button);
  act(() => button.click());
  assert.equal(button.disabled, true);
  act(() => button.click());
  assert.deepEqual(requests, ['broken']);
  await act(async () => {
    finish?.({ status: 'failed' });
    await Promise.resolve();
  });
  assert.match(container.textContent ?? '', /could not be repaired/);
  assert.equal(button.disabled, false);
  act(() => button.click());
  await act(async () => {
    finish?.({ status: 'repaired' });
    await Promise.resolve();
  });
  assert.match(container.textContent ?? '', /Photo repaired/);
});

for (const patch of [{ locked: true }, { syncState: 'offloaded' }, { fileKind: 'video' }] as const) {
  test(`Inspector explains unavailable repair ${JSON.stringify(patch)} (#1098)`, () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <IntlProvider locale="en">
          <PhotoRepairAction photo={{ ...photo, ...patch }} />
        </IntlProvider>,
      ),
    );
    const button = container.querySelector('button');
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.ok(button.title);
  });
}
