import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { IntlHost } from '../../src/renderer/src/i18n/IntlHost.js';
import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import { RestoreWorkflow } from '../../src/renderer/src/restore/RestoreWorkflow.js';

// #748: every result on the restore dialog belongs to exactly one discovery.
// A failed attempt against provider A must not leave its error, session, or
// library list rendered over provider B's screens.

let root: Root | undefined;
let container: HTMLElement | undefined;

type DiscoverRequest = { providerId: string } & Record<string, unknown>;

function mockOverlook(): { discovered: DiscoverRequest[]; restore: () => void } {
  const discovered: DiscoverRequest[] = [];
  const previous = (window as unknown as { overlook?: unknown }).overlook;
  const providers = [
    { id: 'prov-a', label: 'Provider A', available: true, unavailableReason: null },
    { id: 'prov-b', label: 'Provider B', available: true, unavailableReason: null },
  ];
  (window as unknown as { overlook: unknown }).overlook = {
    getLocale: () => Promise.resolve('en-US'),
    settings: {
      get: () => Promise.resolve({ settings: { providerId: 'prov-a' } }),
      onChanged: () => () => undefined,
    },
    backup: {
      providers: () => Promise.resolve({ providers, defaultProviderId: 'prov-a' }),
      providerStatus: () => Promise.resolve({ connected: true, provider: providers[0], accountLabel: null }),
      connect: () => Promise.resolve({ ok: true, reason: null }),
    },
    restore: {
      status: () =>
        Promise.resolve({
          phase: 'idle',
          sessionId: null,
          libraryId: null,
          providerId: null,
          progress: null,
          lastError: null,
          lastResult: null,
          verification: null,
          libraries: [],
        }),
      onProgress: () => () => undefined,
      onStatusChanged: () => () => undefined,
      pickKey: () => Promise.resolve({ path: null }),
      discover: (request: DiscoverRequest) => {
        discovered.push(request);
        if (request.providerId === 'prov-a') {
          return Promise.resolve({
            sessionId: null,
            libraries: [],
            error: { reason: 'corrupt', message: 'manifest references missing blobs/a3/deadbeef' },
          });
        }
        return Promise.resolve({
          sessionId: 'session-b',
          libraries: [
            {
              libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
              generation: 1,
              generatedAt: '2026-07-22T19:32:00.000Z',
              photos: 5,
              totalBytes: 16_200_000,
              albums: 3,
              compatibility: 'compatible',
              validation: 'valid',
              fallbackGenerations: 0,
              resumable: false,
            },
          ],
          error: null,
        });
      },
    },
  };
  return {
    discovered,
    restore: () => {
      (window as unknown as { overlook?: unknown }).overlook = previous;
    },
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

test('a failed discovery error clears when the provider changes (#748)', async () => {
  const mocked = mockOverlook();
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();

    const localKeyButton = [...(container.querySelectorAll('button') ?? [])].find((button) =>
      (button.textContent ?? '').includes("Restore with this Mac's key"),
    );
    assert.ok(localKeyButton, 'the settings context offers the local-key action');
    act(() => {
      localKeyButton.click();
    });
    await flush();
    assert.match(container.textContent ?? '', /manifest references missing/u, 'provider A’s failure renders');

    const select = container.querySelector('select');
    assert.ok(select);
    act(() => {
      select.value = 'prov-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    assert.doesNotMatch(
      container.textContent ?? '',
      /manifest references missing/u,
      'provider A’s stale error must not render over provider B',
    );
  } finally {
    mocked.restore();
  }
});

test('a discovery that resolves AFTER the provider changes is ignored (#748 stale-response)', async () => {
  let resolveA: ((value: unknown) => void) | undefined;
  const previous = (window as unknown as { overlook?: unknown }).overlook;
  const providers = [
    { id: 'prov-a', label: 'Provider A', available: true, unavailableReason: null },
    { id: 'prov-b', label: 'Provider B', available: true, unavailableReason: null },
  ];
  (window as unknown as { overlook: unknown }).overlook = {
    getLocale: () => Promise.resolve('en-US'),
    settings: { get: () => Promise.resolve({ settings: { providerId: 'prov-a' } }), onChanged: () => () => undefined },
    backup: {
      providers: () => Promise.resolve({ providers, defaultProviderId: 'prov-a' }),
      providerStatus: () => Promise.resolve({ connected: true, provider: providers[0], accountLabel: null }),
      connect: () => Promise.resolve({ ok: true, reason: null }),
    },
    restore: {
      status: () =>
        Promise.resolve({
          phase: 'idle',
          sessionId: null,
          libraryId: null,
          providerId: null,
          progress: null,
          lastError: null,
          lastResult: null,
          verification: null,
          libraries: [],
        }),
      onProgress: () => () => undefined,
      onStatusChanged: () => () => undefined,
      pickKey: () => Promise.resolve({ path: null }),
      // Provider A's discovery stays pending until we resolve it by hand, after
      // the user has already moved on to provider B.
      discover: (request: DiscoverRequest) =>
        request.providerId === 'prov-a'
          ? new Promise((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve({ sessionId: 'session-b', libraries: [], error: null }),
    },
  };
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();

    // Start discovery against provider A — its discover() promise stays pending,
    // so the dialog sits on the "Validating cloud libraries…" choose step.
    const localKeyButton = [...(container.querySelectorAll('button') ?? [])].find((button) =>
      (button.textContent ?? '').includes("Restore with this Mac's key"),
    );
    assert.ok(localKeyButton);
    act(() => {
      localKeyButton.click();
    });
    await flush();
    assert.match(container.textContent ?? '', /Validating cloud libraries/u, 'provider A discovery is pending');

    // Press Back before A resolves — this resets discovery (bumps the generation).
    const back = [...(container.querySelectorAll('button') ?? [])].find((button) => (button.textContent ?? '').trim() === 'Back');
    assert.ok(back);
    act(() => {
      back.click();
    });
    await flush();

    // Provider A's discovery finally resolves — with an error that must NOT paint
    // now that Back has superseded it.
    assert.ok(resolveA, 'provider A discovery was started');
    await act(async () => {
      resolveA?.({
        sessionId: null,
        libraries: [],
        error: { reason: 'corrupt', message: 'manifest references missing blobs/a3/deadbeef' },
      });
      await Promise.resolve();
    });
    await flush();
    assert.doesNotMatch(
      container.textContent ?? '',
      /manifest references missing/u,
      'a stale provider-A discovery must not repaint after Back superseded it',
    );
  } finally {
    (window as unknown as { overlook?: unknown }).overlook = previous;
  }
});

test('Back from the library list clears the previous discovery (#748)', async () => {
  const mocked = mockOverlook();
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();

    const select = container.querySelector('select');
    assert.ok(select);
    act(() => {
      select.value = 'prov-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const localKeyButton = [...(container.querySelectorAll('button') ?? [])].find((button) =>
      (button.textContent ?? '').includes("Restore with this Mac's key"),
    );
    assert.ok(localKeyButton);
    act(() => {
      localKeyButton.click();
    });
    await flush();
    assert.match(container.textContent ?? '', /01KY000QE5PMZR2P66DX0CCR6D/u, 'provider B’s library renders');

    const back = [...(container.querySelectorAll('button') ?? [])].find((button) => (button.textContent ?? '').trim() === 'Back');
    assert.ok(back);
    act(() => {
      back.click();
    });
    await flush();
    assert.doesNotMatch(container.textContent ?? '', /01KY000QE5PMZR2P66DX0CCR6D/u, 'the stale library list is gone after Back');
  } finally {
    mocked.restore();
  }
});

test('an unreadable namespace is reported as corrupt, not as a connection failure (#751)', async () => {
  const mocked = mockOverlook();
  const api = (
    window as unknown as {
      overlook: {
        restore: {
          discover: () => Promise<unknown>;
        };
      };
    }
  ).overlook;
  api.restore.discover = () =>
    Promise.resolve({
      sessionId: 'unreadable-session',
      libraries: [
        {
          libraryId: '01JUNREADABLENAMESPACE00001',
          generation: null,
          generatedAt: null,
          photos: null,
          totalBytes: null,
          albums: null,
          compatibility: 'unknown',
          validation: 'corrupt',
          fallbackGenerations: 0,
          resumable: false,
        },
      ],
      error: null,
    });
  try {
    container = document.createElement('div');
    document.body.append(container);
    await act(async () => {
      root = createRoot(container as HTMLElement);
      root.render(
        <IntlHost>
          <AnnouncerProvider>
            <RestoreWorkflow context="settings" />
          </AnnouncerProvider>
        </IntlHost>,
      );
      await Promise.resolve();
    });
    await flush();

    const localKeyButton = [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes("Restore with this Mac's key"),
    );
    assert.ok(localKeyButton);
    act(() => {
      localKeyButton.click();
    });
    await flush();

    assert.match(container.textContent ?? '', /No readable cloud library was found for this key/u);
    assert.match(container.textContent ?? '', /The cloud copy failed validation/u);
    assert.doesNotMatch(container.textContent ?? '', /Check your connection/u);
  } finally {
    mocked.restore();
  }
});
