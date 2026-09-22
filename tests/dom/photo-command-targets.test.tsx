import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, type Dispatch } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider, createIntl } from 'react-intl';

import { photoCommandTargets } from '../../src/renderer/src/commands/photo-command-targets.js';
import {
  usePhotoKeySelection,
  usePhotoKeyTarget,
  useSelectionExportAvailability,
  type PhotoKeyLookup,
} from '../../src/renderer/src/commands/use-photo-key-selection.js';
import { Dialog } from '../../src/renderer/src/components/Dialog.js';
import { SelectionPill } from '../../src/renderer/src/grid/SelectionPill.js';
import { duplicatePhotos } from '../../src/renderer/src/grid/duplicate-photos.js';
import { useExportDialog, type ExportDialogController } from '../../src/renderer/src/export/use-export-dialog.js';
import { useNativeCommandRouter } from '../../src/renderer/src/shell/use-native-command-router.js';
import { AppStateProvider, useAppDispatch, useAppState } from '../../src/renderer/src/state/app-state-context.js';
import type { PhotoKeySelection } from '../../src/shared/ipc/library-selection-channels.js';
import type { AppAction, AppState } from '../../src/shared/library/app-state.js';
import type { CommandId } from '../../src/shared/commands/registry.js';

let root: Root | undefined;
const previous = window.overlook;
const intl = createIntl({ locale: 'en', messages: {} });
let query = (_ids: readonly string[]): Promise<PhotoKeySelection> => Promise.resolve({ photoIds: [], locked: 1, missing: 0 });
let changed = (): void => {};
let duplicated: readonly string[] = [];
function setup(): void {
  (window as unknown as { overlook: unknown }).overlook = {
    library: {
      photoKeySelection: ({ photoIds }: { photoIds: string[] }) => query(photoIds),
      onChanged: (listener: (event: { derivativeOnly: boolean; photoIds: string[] }) => void) => {
        changed = () => listener({ derivativeOnly: false, photoIds: [] });
        return () => {
          changed = () => {};
        };
      },
      onPendingCountChanged: () => () => {},
    },
    variants: {
      duplicate: ({ photoIds }: { photoIds: string[] }) => {
        duplicated = photoIds;
        return Promise.resolve({
          created: photoIds.map((id) => ({ id, derivatives: 'ready' })),
          skipped: 0,
          unsupported: 0,
          pendingCount: 1,
        });
      },
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  (window as unknown as { overlook: unknown }).overlook = previous;
  document.body.replaceChildren();
  duplicated = [];
});
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

let exportDialog: ExportDialogController;
let state: AppState;
let dispatch: Dispatch<AppAction>;
let runCommand: (id: CommandId) => void;
function NativeProbe({ otherWorkflowOpen = false }: { readonly otherWorkflowOpen?: boolean }) {
  exportDialog = useExportDialog();
  state = useAppState();
  dispatch = useAppDispatch();
  runCommand = useNativeCommandRouter({
    nativeCommand: null,
    state,
    dispatch,
    exportDialog,
    onSelectAll: () => {},
    setShortcutSurface: () => {},
    setSettingsSection: () => {},
    setAlbumPickerIds: () => {},
    setLibrariesCreating: () => {},
    resetInteropEntry: () => {},
    resetUnlockAlbum: () => {},
    resetDropped: () => {},
    closeOffload: () => {},
    pcloudEnabled: false,
  });
  return otherWorkflowOpen ? (
    <Dialog open title="Newer workflow">
      <p>Newer workflow</p>
    </Dialog>
  ) : null;
}
function renderNative(otherWorkflowOpen = false): void {
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <AppStateProvider>
          <NativeProbe otherWorkflowOpen={otherWorkflowOpen} />
        </AppStateProvider>
      </IntlProvider>,
    ),
  );
}

test('native export rechecks offscreen singleton and prefers the lightbox over selection (#1235)', async () => {
  setup();
  const requests: string[][] = [];
  query = (ids) => {
    requests.push([...ids]);
    return Promise.resolve({ photoIds: [], locked: ids.length, missing: 0 });
  };
  renderNative();
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['offscreen'] }));
  act(() => runCommand('photo.export'));
  await flush();
  assert.deepEqual(requests, [['offscreen']]);
  assert.equal(state.exportOpen, false);
  assert.match(state.toast?.title ?? '', /1 locked photo/);
  act(() => dispatch({ type: 'lightbox/opened', photoId: 'focused' }));
  act(() => runCommand('photo.export'));
  await flush();
  assert.deepEqual(requests[1], ['focused']);
  assert.equal(state.exportOpen, false);
  query = (ids) => Promise.resolve({ photoIds: ids, locked: 0, missing: 0 });
  act(() => runCommand('photo.export'));
  await flush();
  assert.equal(state.exportOpen, true);
});

test('export discards an in-flight result after the target selection changes (#1235)', async () => {
  setup();
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  query = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  renderNative();
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['old'] }));
  act(() => runCommand('photo.export'));
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['new'] }));
  // Returning to the old IDs must not revive a superseded invocation.
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['old'] }));
  await act(async () => {
    finish?.({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(state.exportOpen, false);
});

test('context export preserves captured targets when the menu restores selection (#1235)', async () => {
  setup();
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  const requested: string[][] = [];
  query = (ids) =>
    new Promise((resolve) => {
      requested.push([...ids]);
      finish = resolve;
    });
  renderNative();
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['previous'] }));
  const selectionBeforeOpen = [...state.selection];
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['context-photo'] }));
  act(() => {
    exportDialog.openPhotos(['context-photo']);
    dispatch({ type: 'selection/replaced', photoIds: selectionBeforeOpen });
  });
  await act(async () => {
    finish?.({ photoIds: ['context-photo'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(requested, [['context-photo']]);
  assert.deepEqual([...state.selection], ['previous']);
  assert.equal(state.exportOpen, true);
  const dialog = exportDialog.dialog;
  assert.ok(dialog);
  assert.deepEqual((dialog.props as { photoIds: readonly string[] }).photoIds, ['context-photo']);
});

test('a newer export invocation supersedes a captured context target (#1235)', async () => {
  setup();
  const pending: ((result: PhotoKeySelection) => void)[] = [];
  query = () => new Promise((resolve) => pending.push(resolve));
  renderNative();
  act(() => exportDialog.openPhotos(['old']));
  act(() => exportDialog.openPhotos(['new']));
  await act(async () => {
    pending[1]?.({ photoIds: ['new'], locked: 0, missing: 0 });
    await Promise.resolve();
    pending[0]?.({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  const dialog = exportDialog.dialog;
  assert.ok(dialog);
  assert.deepEqual((dialog.props as { photoIds: readonly string[] }).photoIds, ['new']);
});

test('changing protected scope cancels a pending explicit export (#1235)', async () => {
  setup();
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  query = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  renderNative();
  act(() => exportDialog.openPhotos(['ordinary']));
  act(() => dispatch({ type: 'protectedAlbum/set', albumId: 'protected' }));
  await act(async () => {
    finish?.({ photoIds: ['ordinary'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(state.exportOpen, false);
});

for (const dialog of ['import', 'settings', 'libraries', 'activity', 'duplicates'] as const) {
  test(`opening ${dialog} cancels a pending export without replacing the newer workflow (#1235)`, async () => {
    setup();
    let finish: ((result: PhotoKeySelection) => void) | undefined;
    query = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    renderNative();
    act(() => dispatch({ type: 'selection/replaced', photoIds: ['old'] }));
    act(() => (dialog === 'import' ? runCommand('photo.export') : exportDialog.openPhotos(['old'])));
    act(() => dispatch({ type: 'dialog/set', dialog, open: true }));
    await act(async () => {
      finish?.({ photoIds: ['old'], locked: 1, missing: 0 });
      await Promise.resolve();
    });
    assert.equal(state.exportOpen, false);
    assert.equal(state[`${dialog}Open`], true);
    assert.equal(state.toast, null, 'a superseded request must not publish skipped-photo feedback');
  });
}

test('a dialog opened and closed in one render still supersedes pending export (#1235)', async () => {
  setup();
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  query = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  renderNative();
  act(() => exportDialog.openPhotos(['old']));
  act(() => {
    dispatch({ type: 'dialog/set', dialog: 'settings', open: true });
    dispatch({ type: 'dialog/set', dialog: 'settings', open: false });
  });
  await act(async () => {
    finish?.({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(state.settingsOpen, false);
  assert.equal(state.exportOpen, false);
});

test('shell overlays supersede pending export and refuse a new one until closed (#1235)', async () => {
  setup();
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  const requests: string[][] = [];
  query = (ids) =>
    new Promise((resolve) => {
      requests.push([...ids]);
      finish = resolve;
    });
  renderNative();
  act(() => exportDialog.openPhotos(['old']));
  renderNative(true);
  act(() => exportDialog.openPhotos(['blocked']));
  assert.deepEqual(requests, [['old']]);
  renderNative(false);
  await act(async () => {
    finish?.({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(state.exportOpen, false);
  query = (ids) => Promise.resolve({ photoIds: ids, locked: 0, missing: 0 });
  act(() => exportDialog.openPhotos(['fresh']));
  await flush();
  assert.equal(state.exportOpen, true);
});

test('mixed pixel commands filter authoritatively and retain localized skipped counts (#1235)', async () => {
  setup();
  query = () => Promise.resolve({ photoIds: ['eligible-offscreen'], locked: 2, missing: 1 });
  const result = await photoCommandTargets('photo.export', ['eligible-offscreen', 'locked-a', 'locked-b', 'missing'], intl);
  assert.deepEqual(result.photoIds, ['eligible-offscreen']);
  assert.equal(result.notice, 'Skipped 2 locked photos and 1 unavailable photo.');
  const actions: AppAction[] = [];
  duplicatePhotos((action) => actions.push(action), ['eligible-offscreen', 'locked-a', 'locked-b', 'missing'], intl);
  await flush();
  assert.deepEqual(duplicated, ['eligible-offscreen']);
  const toast = [...actions].reverse().find((action) => action.type === 'toast/shown');
  assert.equal(toast?.type, 'toast/shown');
  if (toast?.type === 'toast/shown') assert.match(toast.toast?.title ?? '', /Skipped 2 locked photos and 1 unavailable photo/);
  query = () => Promise.reject(new Error('must not query metadata actions'));
  assert.deepEqual(await photoCommandTargets('photo.favorite.toggle', ['locked-a'], intl), { photoIds: ['locked-a'], notice: null });
  assert.deepEqual((await photoCommandTargets('photo.export', ['locked-a'], intl)).photoIds, []);
});

let snapshot: PhotoKeyLookup['state'];
function KeyProbe({ ids }: { readonly ids: readonly string[] }) {
  snapshot = usePhotoKeySelection(ids).state;
  return null;
}
test('availability ignores stale responses and reloads offscreen custody on key return (#1235)', async () => {
  setup();
  const pending: { ids: readonly string[]; resolve: (result: PhotoKeySelection) => void }[] = [];
  query = (ids) => new Promise((resolve) => pending.push({ ids, resolve }));
  act(() => root?.render(<KeyProbe ids={['old']} />));
  act(() => root?.render(<KeyProbe ids={['new']} />));
  await act(async () => {
    pending[0]?.resolve({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(snapshot, { status: 'loading' });
  await act(async () => {
    pending[1]?.resolve({ photoIds: [], locked: 1, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(snapshot, { status: 'ready', result: { photoIds: [], locked: 1, missing: 0 } });
  act(() => changed());
  assert.deepEqual(snapshot, { status: 'loading' });
  assert.deepEqual(pending[2]?.ids, ['new']);
  await act(async () => {
    pending[2]?.resolve({ photoIds: ['new'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(snapshot, { status: 'ready', result: { photoIds: ['new'], locked: 0, missing: 0 } });
});

const pillSelection = new Set(['offscreen']);
function PillProbe({ onExport }: { readonly onExport: () => void }) {
  const availability = useSelectionExportAvailability(pillSelection);
  return (
    <SelectionPill
      count={1}
      onClear={() => {}}
      onExport={onExport}
      exportDisabledReason={availability.disabledReason}
      onRetryExport={availability.retry}
    />
  );
}

test('both pill layouts disable Export while preserving metadata actions (#1235)', async () => {
  setup();
  query = () => Promise.resolve({ photoIds: [], locked: 1, missing: 0 });
  let exports = 0;
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <PillProbe
          onExport={() => {
            exports++;
          }}
        />
      </IntlProvider>,
    ),
  );
  await flush();
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const wide = buttons.find((button) => button.textContent?.includes('Export'));
  assert.equal(wide?.disabled, true);
  assert.match(wide?.title ?? '', /keys that are not on this device/);
  assert.equal(buttons.find((button) => button.textContent?.includes('Add to album'))?.disabled, false);
  const more = buttons.find((button) => button.getAttribute('aria-label') === 'More selection actions');
  act(() => more?.click());
  const overflow = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) =>
    button.textContent?.includes('Export'),
  );
  assert.equal(overflow?.disabled, true);
  act(() => {
    wide?.click();
    overflow?.click();
  });
  assert.equal(exports, 0);
  query = (ids) => Promise.resolve({ photoIds: ids, locked: 0, missing: 0 });
  act(() => changed());
  await flush();
  assert.equal(wide?.disabled, false);
  assert.equal(overflow?.disabled, false);
  act(() => wide?.click());
  assert.equal(exports, 1);
});

test('both pill layouts expose failure and recover through an explicit custody retry (#1235)', async () => {
  setup();
  query = () => Promise.reject(new Error('temporary lookup failure'));
  let exports = 0;
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <PillProbe
          onExport={() => {
            exports++;
          }}
        />
      </IntlProvider>,
    ),
  );
  await flush();
  const wideRetry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry photo keys');
  assert.ok(wideRetry);
  assert.equal(wideRetry.disabled, false);
  assert.equal(
    document.getElementById(wideRetry.getAttribute('aria-describedby') ?? '')?.textContent,
    'Could not verify photo keys. Try again.',
  );
  const more = document.querySelector<HTMLButtonElement>('button[aria-label="More selection actions"]');
  act(() => more?.click());
  const menuRetry = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === 'Retry photo keys',
  );
  assert.ok(menuRetry);
  assert.equal(menuRetry.disabled, false);
  let finish: ((result: PhotoKeySelection) => void) | undefined;
  query = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  act(() => menuRetry.click());
  assert.equal(wideRetry.disabled, true);
  assert.equal(wideRetry.title, 'Checking photo keys…');
  assert.equal(exports, 0);
  await act(async () => {
    finish?.({ photoIds: ['offscreen'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(wideRetry.disabled, false);
  assert.equal(menuRetry.disabled, false);
  assert.match(wideRetry.textContent ?? '', /Export/);
  act(() => wideRetry.click());
  assert.equal(exports, 1);
});

let nativeCanRetry = false;
function NativeMenuProbe() {
  nativeCanRetry = usePhotoKeyTarget(useAppState());
  return null;
}

test('native retry after a lookup failure still requires a successful invocation preflight (#1235)', async () => {
  setup();
  query = () => Promise.reject(new Error('temporary lookup failure'));
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <AppStateProvider>
          <NativeProbe />
          <NativeMenuProbe />
        </AppStateProvider>
      </IntlProvider>,
    ),
  );
  act(() => dispatch({ type: 'selection/replaced', photoIds: ['offscreen'] }));
  await flush();
  assert.equal(nativeCanRetry, true);
  act(() => runCommand('photo.export'));
  await flush();
  assert.equal(state.exportOpen, false);
  assert.equal(state.toast?.title, 'Could not verify photo keys. Try again.');
  query = (ids) => Promise.resolve({ photoIds: ids, locked: 0, missing: 0 });
  act(() => runCommand('photo.export'));
  await flush();
  assert.equal(state.exportOpen, true);
});
