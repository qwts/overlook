import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { IntlHost } from '../../src/renderer/src/i18n/IntlHost.js';
import { RestoreWorkflow } from '../../src/renderer/src/restore/RestoreWorkflow.js';

// #915: a partial restore reports every NOT FOUND object on the complete
// screen — the full path list, the re-run guidance, and the pointer at the
// durable restore-report.json — instead of pretending the restore was whole.

let root: Root | undefined;
let container: HTMLElement | undefined;

const MISSING = [
  {
    path: 'blobs/92/92fde3d32785e2247c61d1be0d07416d18aa1309e0664c1b63166622f5daf226',
    kind: 'original',
    photoId: 'P2',
    reason: 'not-found',
  },
  { path: 'sidecars/P3/aa11bb22cc33', kind: 'sidecar', photoId: 'P3', reason: 'failed-verification' },
] as const;

function mockOverlook(missing: readonly (typeof MISSING)[number][]): () => void {
  const previous = (window as unknown as { overlook?: unknown }).overlook;
  const providers = [{ id: 'prov-a', label: 'Provider A', available: true, unavailableReason: null }];
  (window as unknown as { overlook: unknown }).overlook = {
    getLocale: () => Promise.resolve('en-US'),
    settings: { get: () => Promise.resolve({ settings: { providerId: 'prov-a' } }), onChanged: () => () => undefined },
    backup: {
      providers: () => Promise.resolve({ providers, defaultProviderId: 'prov-a' }),
      providerStatus: () => Promise.resolve({ connected: true, provider: providers[0], account: null }),
      connect: () => Promise.resolve({ ok: true, reason: null }),
    },
    restore: {
      onProgress: () => () => undefined,
      pickKey: () => Promise.resolve({ path: null }),
      discover: () =>
        Promise.resolve({
          sessionId: 'session-a',
          libraries: [
            {
              libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
              generation: 3,
              generatedAt: '2026-07-22T19:32:00.000Z',
              photos: 3,
              totalBytes: 16_200_000,
              albums: 1,
              compatibility: 'compatible',
              validation: 'valid',
              fallbackGenerations: 0,
              resumable: false,
            },
          ],
          error: null,
        }),
      run: () =>
        Promise.resolve({
          result: {
            libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
            generation: 3,
            photos: 3,
            resumed: false,
            fallbackFromGeneration: null,
            relaunching: false,
            missing,
          },
          error: null,
        }),
      cancel: () => Promise.resolve({}),
    },
  };
  return () => {
    (window as unknown as { overlook?: unknown }).overlook = previous;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

async function runToComplete(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    root = createRoot(container as HTMLElement);
    root.render(
      <IntlHost>
        <RestoreWorkflow context="onboarding" />
      </IntlHost>,
    );
    await Promise.resolve();
  });
  await flush();

  const localKeyButton = [...(container.querySelectorAll('button') ?? [])].find((button) =>
    (button.textContent ?? '').includes("Restore with this Mac's key"),
  );
  assert.ok(localKeyButton, 'the local-key action is offered');
  act(() => {
    localKeyButton.click();
  });
  await flush();

  const review = [...(container.querySelectorAll('button') ?? [])].find((button) => (button.textContent ?? '').includes('Review restore'));
  assert.ok(review, 'a valid library enables review');
  act(() => {
    review.click();
  });
  await flush();

  const restore = [...(container.querySelectorAll('button') ?? [])].find((button) => (button.textContent ?? '').startsWith('Restore '));
  assert.ok(restore, 'the confirm step offers the restore action');
  act(() => {
    restore.click();
  });
  await flush();
  return container;
}

test('a partial restore lists every NOT FOUND object with re-run guidance (#915)', async () => {
  const restoreMock = mockOverlook([...MISSING]);
  try {
    const host = await runToComplete();
    const block = host.querySelector('[data-testid="restore-missing"]');
    assert.ok(block, 'the NOT FOUND report renders on the complete screen');
    const text = block.textContent ?? '';
    assert.match(text, /2 objects were not found/u);
    for (const object of MISSING) {
      assert.ok(text.includes(object.path), `${object.path} is listed`);
    }
    assert.match(text, /run the\s+restore again/u, 'recovery guidance names the re-run path');
    assert.match(text, /restore-report\.json/u, 'the durable report file is named');
    assert.match(host.textContent ?? '', /NOT FOUND/u, 'the heading says the restore is incomplete');
  } finally {
    restoreMock();
  }
});

test('a complete restore renders no NOT FOUND report (#915)', async () => {
  const restoreMock = mockOverlook([]);
  try {
    const host = await runToComplete();
    assert.equal(host.querySelector('[data-testid="restore-missing"]'), null);
    assert.match(host.textContent ?? '', /Restore complete/u);
    assert.doesNotMatch(host.textContent ?? '', /NOT FOUND/u);
  } finally {
    restoreMock();
  }
});
