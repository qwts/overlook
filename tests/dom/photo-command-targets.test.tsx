import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, type Dispatch } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider, createIntl } from 'react-intl';

import { photoCommandTargets } from '../../src/renderer/src/commands/photo-command-targets.js';
import { usePhotoKeySelection, useSelectionExportReason } from '../../src/renderer/src/commands/use-photo-key-selection.js';
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
function NativeProbe() {
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
  return null;
}
function renderNative(): void {
  act(() =>
    root?.render(
      <IntlProvider locale="en">
        <AppStateProvider>
          <NativeProbe />
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
  await act(async () => {
    finish?.({ photoIds: ['old'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.equal(state.exportOpen, false);
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

let snapshot: PhotoKeySelection | null;
function KeyProbe({ ids }: { readonly ids: readonly string[] }) {
  snapshot = usePhotoKeySelection(ids);
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
  assert.equal(snapshot, null);
  await act(async () => {
    pending[1]?.resolve({ photoIds: [], locked: 1, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(snapshot, { photoIds: [], locked: 1, missing: 0 });
  act(() => changed());
  assert.equal(snapshot, null);
  assert.deepEqual(pending[2]?.ids, ['new']);
  await act(async () => {
    pending[2]?.resolve({ photoIds: ['new'], locked: 0, missing: 0 });
    await Promise.resolve();
  });
  assert.deepEqual(snapshot, { photoIds: ['new'], locked: 0, missing: 0 });
});

const pillSelection = new Set(['offscreen']);
function PillProbe({ onExport }: { readonly onExport: () => void }) {
  const reason = useSelectionExportReason(pillSelection);
  return <SelectionPill count={1} onClear={() => {}} onExport={onExport} exportDisabledReason={reason} />;
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
