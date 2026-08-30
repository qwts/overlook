import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { IntlHost } from '../../src/renderer/src/i18n/IntlHost.js';
import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
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

interface RestoreMock {
  readonly cleanup: () => void;
  readonly calls: {
    readonly runs: unknown[];
    readonly csvExports: unknown[];
    readonly corruptExports: unknown[];
    readonly trash: unknown[];
    readonly copies: string[];
  };
}

function mockOverlook(missing: readonly (typeof MISSING)[number][]): RestoreMock {
  const previous = (window as unknown as { overlook?: unknown }).overlook;
  const providers = [{ id: 'prov-a', label: 'Provider A', available: true, unavailableReason: null }];
  const missingCount = missing.filter((o) => o.reason === 'not-found').length;
  const corruptCount = missing.filter((o) => o.reason === 'failed-verification').length;
  const verifiedCount = 3 - missing.filter((o) => o.kind === 'original').length;
  const calls = {
    runs: [] as unknown[],
    csvExports: [] as unknown[],
    corruptExports: [] as unknown[],
    trash: [] as unknown[],
    copies: [] as string[],
  };
  (window as unknown as { overlook: unknown }).overlook = {
    getLocale: () => Promise.resolve('en-US'),
    clipboard: {
      writeText: (text: string) => {
        calls.copies.push(text);
        return Promise.resolve();
      },
    },
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
      verify: () =>
        Promise.resolve({
          result: {
            verificationId: 'verification-a',
            libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
            generation: 3,
            photos: 3,
            verifiedCount: Math.max(0, verifiedCount),
            missingCount,
            corruptCount,
            missing,
          },
          error: null,
        }),
      exportCsv: (request: unknown) => {
        calls.csvExports.push(request);
        return Promise.resolve({ exported: true, path: '/tmp/gaps.csv', error: null });
      },
      exportCorrupt: (request: unknown) => {
        calls.corruptExports.push(request);
        return Promise.resolve({
          exported: false,
          count: 0,
          unavailable: 1,
          error: '0 decryptable images exported; 1 corrupt object unavailable.',
        });
      },
      trash: (request: unknown) => {
        calls.trash.push(request);
        return Promise.resolve({ trashed: false, error: { reason: 'io', message: 'One cloud object remains.' } });
      },
      run: (request: unknown) => {
        calls.runs.push(request);
        return Promise.resolve({
          result: {
            libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
            generation: 3,
            photos: Math.max(0, verifiedCount),
            resumed: false,
            fallbackFromGeneration: null,
            relaunching: false,
            missing,
          },
          error: null,
        });
      },
      cancel: () => Promise.resolve({}),
    },
  };
  return { calls, cleanup: () => ((window as unknown as { overlook?: unknown }).overlook = previous) };
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

async function renderToVerified(): Promise<HTMLElement> {
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

  const verifyBtn = [...(container.querySelectorAll('button') ?? [])].find((button) =>
    (button.textContent ?? '').includes('Verify backup'),
  );
  assert.ok(verifyBtn, 'a valid library enables verify');
  act(() => {
    verifyBtn.click();
  });
  await flush();
  await flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await flush();

  return container;
}

async function runToComplete(expectGaps: boolean): Promise<HTMLElement> {
  const host = await renderToVerified();
  // #994: verify always lands on the results screen. A clean scan no longer
  // auto-advances, so Heal is an explicit choice whether or not there are gaps.
  const healBtn = [...host.querySelectorAll('button')].find((button) => (button.textContent ?? '').startsWith('Heal'));
  assert.ok(healBtn, 'the results screen offers Heal');
  assert.equal(
    host.querySelector('.ovl-restore__verifyList') !== null,
    expectGaps,
    expectGaps ? 'the gap list is on screen before healing' : 'a clean verification lists no gaps',
  );
  act(() => {
    healBtn.click();
  });
  await flush();

  const authorize = host.querySelector('input[type="checkbox"]');
  assert.ok(authorize instanceof HTMLInputElement, 'the settings context requires replacement authorization');
  act(() => {
    authorize.click();
  });
  await flush();

  const restore = [...(host.querySelectorAll('button') ?? [])].find((button) => (button.textContent ?? '').startsWith('Restore '));
  assert.ok(restore, 'the confirm step offers the restore action');
  act(() => {
    restore.click();
  });
  await flush();
  return host;
}

test('a reduced restore lists every excluded object and explains the new cloud truth (#915/#947)', async () => {
  const restoreMock = mockOverlook([...MISSING]);
  try {
    const host = await runToComplete(true);
    const block = host.querySelector('[data-testid="restore-missing"]');
    assert.ok(block, 'the NOT FOUND report renders on the complete screen');
    const text = block.textContent ?? '';
    assert.match(text, /2 objects were not found/u);
    for (const object of MISSING) {
      assert.ok(text.includes(object.path), `${object.path} is listed`);
    }
    assert.match(text, /moved to the provider Trash when present/u, 'guidance explains what happened to the gap objects');
    assert.match(text, /restore-report\.json/u, 'the durable report file is named');
    assert.match(text, /quarantine\/gen-N\/gaps\.json/u, 'the quarantine gap list is named (#994)');
    assert.match(host.textContent ?? '', /NOT FOUND/u, 'the heading says the restore is incomplete');
    assert.match(host.textContent ?? '', /2 photos restored/u, 'the complete screen reports the reduced restored count');
    const copyPaths = MISSING.map((object) =>
      [...block.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Copy remote path ${object.path}`),
    );
    assert.ok(copyPaths.every(Boolean), 'every excluded remote path has a uniquely named copy affordance');
    act(() => copyPaths[0]?.click());
    await flush();
    assert.deepEqual(restoreMock.calls.copies, [MISSING[0].path]);
    assert.deepEqual(restoreMock.calls.runs, [
      {
        sessionId: 'session-a',
        libraryId: '01KY000QE5PMZR2P66DX0CCR6D',
        verificationId: 'verification-a',
        allowReplace: true,
      },
    ]);
  } finally {
    restoreMock.cleanup();
  }
});

test('a complete restore renders no NOT FOUND report (#915)', async () => {
  const restoreMock = mockOverlook([]);
  try {
    const host = await runToComplete(false);
    assert.equal(host.querySelector('[data-testid="restore-missing"]'), null);
    assert.match(host.textContent ?? '', /Restore complete/u);
    assert.doesNotMatch(host.textContent ?? '', /NOT FOUND/u);
    assert.match(host.textContent ?? '', /3 photos restored/u);
  } finally {
    restoreMock.cleanup();
  }
});

test('gap triage exposes all five truthful actions and retains failures on screen (#994)', async () => {
  const restoreMock = mockOverlook([...MISSING]);
  try {
    const host = await renderToVerified();
    const buttons = [...host.querySelectorAll('button')];
    const csv = buttons.find((button) => button.textContent?.includes('Export missing/corrupt list'));
    const corrupt = buttons.find((button) => button.textContent?.includes('Save corrupt copies'));
    const proceed = buttons.find((button) => button.textContent?.startsWith('Heal'));
    const trash = buttons.find((button) => button.textContent?.includes('Discard this backup'));
    // #994: Do nothing is a first-class exit — cancelling must not require
    // picking one of the mutating actions.
    const doNothing = buttons.find((button) => button.textContent?.includes('Do nothing'));
    assert.ok(csv);
    assert.ok(corrupt);
    assert.ok(proceed);
    assert.ok(trash);
    assert.ok(doNothing);
    const copyPaths = MISSING.map((object) =>
      buttons.find((button) => button.getAttribute('aria-label') === `Copy remote path ${object.path}`),
    );
    assert.ok(copyPaths.every(Boolean), 'verification paths have distinct accessible copy names');
    act(() => copyPaths[0]?.click());
    await flush();

    act(() => csv.click());
    await flush();
    assert.match(host.textContent ?? '', /CSV exported to \/tmp\/gaps\.csv/u);
    act(() => corrupt.click());
    await flush();
    assert.match(host.textContent ?? '', /0 decryptable images exported; 1 corrupt object unavailable/u);
    act(() => trash.click());
    await flush();
    assert.match(host.textContent ?? '', /Trash or Recently Deleted/u);
    const confirmation = host.querySelector('input[placeholder="Permanently Delete Backup"]');
    assert.ok(confirmation instanceof HTMLInputElement);
    act(() => {
      Object.defineProperty(confirmation, 'value', {
        configurable: true,
        value: 'Permanently Delete Backup',
        writable: true,
      });
      confirmation.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const confirm = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirm trash'));
    assert.ok(confirm);
    assert.equal(confirm.disabled, false);
    act(() => confirm.click());
    await flush();
    assert.match(host.textContent ?? '', /One cloud object remains/u);
    assert.equal(host.querySelector('[data-testid="restore-verify"]') !== null, true, 'partial trash failure retains the triage session');
    const details = host.querySelector('details');
    const summary = details?.querySelector('summary');
    assert.ok(summary);
    act(() => summary.click());
    const copy = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Copy recovery error details');
    assert.ok(copy);
    act(() => copy.click());
    await flush();
    // #806: the copy affordance rides the app clipboard bridge — the
    // sandboxed renderer's navigator.clipboard silently no-ops.
    assert.deepEqual(restoreMock.calls.copies, [MISSING[0].path, 'reason: io\nmessage: One cloud object remains.']);
    assert.equal(restoreMock.calls.csvExports.length, 1);
    assert.equal(restoreMock.calls.corruptExports.length, 1);
    assert.equal(restoreMock.calls.trash.length, 1);
  } finally {
    restoreMock.cleanup();
  }
});
