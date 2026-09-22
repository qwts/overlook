import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { useEffect, useState, type ComponentProps } from 'react';

import { Sidebar } from './Sidebar';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { AlbumListing, LibraryStats, SourceCounts } from '../../../shared/library/types.js';
import { commandById } from '../../../shared/commands/registry.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { beginPhotoDrag } from '../grid/photo-drag-session';
import { endAlbumReorderDrag } from './album-reorder-drag-session';

// #238 exit criteria: the sidebar collapses to the 56px icon rail (labels
// and counts move to right-side tooltips, headings become dividers, the
// backup card becomes the shield button that opens Settings) and the state
// persists under the mock's own localStorage key across mounts.

const COLLAPSE_KEY = 'overlook.sidebarCollapsed';
const renameAlbum = fn();
const deleteAlbum = fn();
const addPhotos = fn((request: { photoIds: readonly string[] }) => Promise.resolve({ added: request.photoIds.length }));
const movePhotos = fn((request: { photoIds: readonly string[] }) =>
  Promise.resolve({ moved: request.photoIds.length, alreadyInTarget: 0 }),
);
const reorderAlbum = fn((request: { position: number }) => Promise.resolve({ changed: true, position: request.position, total: 2 }));
const moveAlbum = fn<(request: Parameters<OverlookApi['albums']['move']>[0]) => Promise<{ refusal: 'cycle' | 'depth' } | undefined>>(() =>
  Promise.resolve(undefined),
);
const deleteFolder = fn();

/** A row reveals its actions button on hover/focus (pointer-events: none
 * until then): focus first so user-event's pointer check sees a live target. */
async function openActions(actions: HTMLElement): Promise<void> {
  actions.focus();
  await waitFor(() => expect(window.getComputedStyle(actions).pointerEvents).toBe('auto'));
  await userEvent.click(actions);
}

/** A listing fixture: a top-level, visible, untagged album unless overridden (#505). */
function listing(overrides: Partial<AlbumListing> & Pick<AlbumListing, 'id' | 'name' | 'count'>): AlbumListing {
  return {
    showInAllPhotos: true,
    visibleElsewhere: 0,
    visibleVia: [],
    kind: 'album',
    parentId: null,
    inheritsVisibility: false,
    tags: [],
    predicate: null,
    unsupported: null,
    ...overrides,
  };
}

function installStub(): void {
  // Sidebar listens to backup progress; AppStateProvider to pending pushes.
  // Both stay silent here — the stories drive the component with props.
  const library = { onPendingCountChanged: () => () => undefined } as unknown as OverlookApi['library'];
  const backup = {
    onProgress: () => () => undefined,
    onCompleted: () => () => undefined,
  } as unknown as OverlookApi['backup'];
  const albumActions = {
    rename: (request: unknown) => {
      renameAlbum(request);
      return Promise.resolve({});
    },
    delete: (request: { albumId: string; folder?: unknown }) => {
      (request.folder === undefined ? deleteAlbum : deleteFolder)(request);
      return Promise.resolve({});
    },
    addPhotos,
    movePhotos,
    reorder: reorderAlbum,
    move: (request: { albumId: string; parentId: string | null }) => {
      void moveAlbum(request);
      return Promise.resolve({ album: listing({ id: request.albumId, name: 'Iceland', count: 214, parentId: request.parentId }) });
    },
  } as unknown as OverlookApi['albums'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library, backup, albums: albumActions };
}

const counts: SourceCounts = {
  all: 204318,
  favorites: 11,
  recent: 96,
  raw: 0,
  offloaded: 12,
  unavailable: 0,
  deleted: 3,
  excluded: 0,
  hiddenByAlbums: 0,
};
const stats: LibraryStats = {
  photos: 204318,
  bytes: 1_580_000_000_000,
  pending: 0,
  lastBackupAt: null,
  offloadedBytes: 380_000_000_000,
  excludedCount: 0,
  excludedBytes: 0,
  pendingRemovals: 0,
};
const albums: readonly AlbumListing[] = [
  listing({ id: 'a1', name: 'Iceland', count: 214 }),
  listing({ id: 'a2', name: 'Studio scans', count: 1042 }),
];

const meta: Meta<typeof Sidebar> = {
  title: 'App/Sidebar',
  component: Sidebar,
  args: { platform: 'darwin', counts, stats, albums },
  decorators: [
    (Story) => {
      installStub();
      return (
        <AppStateProvider>
          <div style={{ height: 480, display: 'flex' }}>
            <Story />
          </div>
        </AppStateProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof Sidebar>;

function ForceProvider({ label }: { readonly label: string }): null {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch({ type: 'provider/set', connected: true, label });
  }, [dispatch, label]);
  return null;
}

export const Expanded: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  render: (args) => (
    <>
      <ForceProvider label="Google Drive" />
      <Sidebar {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Library' })).toBeInTheDocument();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Albums' })).toBeInTheDocument();
    await expect(canvas.getByText('All Photos')).toBeVisible();
    // Regression (#690): Activity is a Help-menu command, never a sidebar row —
    // it must not appear under (or anywhere alongside) the ALBUMS list.
    await expect(canvas.queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument();
    await expect(canvas.queryByText('Activity')).not.toBeInTheDocument();
    // Offloaded earns its row here: counts.offloaded is 12 (#268).
    await expect(canvas.getByText('Offloaded')).toBeVisible();
    await expect(canvas.getByTestId('backup-card')).toBeVisible();
    await expect(canvas.getByText('1.2 TB on disk')).toBeVisible();
    const offloadRow = await canvas.findByText('380 GB offload (Google Drive)');
    await expect(offloadRow).toBeVisible();
    await expect(window.getComputedStyle(offloadRow).whiteSpace).toBe('nowrap');
    const storage = offloadRow.parentElement;
    await expect(storage).not.toBeNull();
    await expect(offloadRow.scrollWidth).toBeLessThanOrEqual(storage?.clientWidth ?? 0);
    await expect(canvas.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    const newAlbum = canvas.getByRole('button', { name: 'New album' });
    await expect(newAlbum.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await expect(newAlbum.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
  },
};

export const RightToLeft: Story = {
  globals: { locale: 'en-XB' },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.ownerDocument.documentElement).toHaveAttribute('dir', 'rtl'));
    const sidebar = canvasElement.querySelector('.ovl-sidebar');
    await expect(sidebar).not.toBeNull();
    const hostBounds = canvasElement.getBoundingClientRect();
    const sidebarBounds = sidebar?.getBoundingClientRect();
    await expect(sidebarBounds?.right).toBeCloseTo(hostBounds.right, 0);
    const collapseIcon = canvasElement.querySelector<SVGElement>('[data-icon-name="panel-left-close"]');
    await expect(collapseIcon).not.toBeNull();
    await expect(window.getComputedStyle(collapseIcon as SVGElement).transform).not.toBe('none');
  },
};

export const CollapseAndExpand: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Collapse sidebar' }));
    // Rail mode: labels/counts gone, headings replaced by dividers, the
    // backup card replaced by the shield; the choice persisted.
    await waitFor(async () => {
      await expect(canvas.queryByText('All Photos')).not.toBeInTheDocument();
    });
    await expect(canvas.queryByText('Library')).not.toBeInTheDocument();
    await expect(canvas.queryByTestId('backup-card')).not.toBeInTheDocument();
    await expect(canvas.getByTestId('backup-shield')).toBeVisible();
    await expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1');
    // The rail's icon-square metrics must win over the base row rule
    // (PR #245 review — source-order regression guard).
    const railRow = canvas.getByRole('button', { name: 'All Photos · 204,318' });
    await expect(window.getComputedStyle(railRow).width).toBe('36px');
    await expect(window.getComputedStyle(railRow).height).toBe('32px');
    // Every destination stays reachable: a rail row hover surfaces the
    // label + count in a right-side tooltip.
    // The just-clicked toggle keeps focus (and so its own tooltip) — query
    // all open tooltips and find the row's.
    await userEvent.hover(canvas.getByRole('button', { name: 'All Photos · 204,318' }));
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      const tips = body.getAllByRole('tooltip').map((tip) => tip.textContent);
      await expect(tips).toContain('All Photos · 204,318');
    });
    await userEvent.unhover(canvas.getByRole('button', { name: 'All Photos · 204,318' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Expand sidebar' }));
    await waitFor(async () => {
      await expect(canvas.getByText('All Photos')).toBeVisible();
    });
    await expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('0');
  },
};

export const StartsCollapsedFromPersistedState: Story = {
  loaders: [
    () => {
      window.localStorage.setItem(COLLAPSE_KEY, '1');
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(canvas.queryByText('All Photos')).not.toBeInTheDocument();
    await expect(canvas.getByTestId('backup-shield')).toBeVisible();
  },
};

// Story-only helper: flips the provider to disconnected the way Shell's
// settings sync would (#239).
function ForceDisconnected(): null {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch({ type: 'providerConnected/set', connected: false });
  }, [dispatch]);
  return null;
}

export const Disconnected: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  render: (args) => (
    <>
      <ForceDisconnected />
      <Sidebar {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // No fabricated backup state: the progress figure is gone, the storage
    // summary is on-disk-only, and the Connect path is offered.
    await waitFor(async () => {
      await expect(canvas.getByTestId('sidebar-connect')).toBeVisible();
    });
    await expect(canvas.getByTestId('backup-card')).not.toHaveTextContent('CLOUD');
    await expect(canvas.getByText('1.2 TB on disk')).toBeVisible();
    await expect(canvas.queryByText(/OFFLOAD/)).not.toBeInTheDocument();
    await expect(canvas.getByText('Library encrypted')).toBeVisible();
  },
};

// #268: no offload flow exists in-app yet — an always-empty Offloaded
// destination reads as broken, so the row only appears once rows exist.
export const OffloadedHiddenWhenEmpty: Story = {
  args: { counts: { ...counts, offloaded: 0 } },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('All Photos')).toBeVisible();
    await expect(canvas.queryByText('Offloaded')).not.toBeInTheDocument();
  },
};

// Derived sources (#512): RAW and Unavailable appear only with members and
// then carry exact counts, in a fixed order between Recent and Trash.
export const DerivedSourcesWithCounts: Story = {
  args: { counts: { ...counts, raw: 418, unavailable: 7 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'RAW 418' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Unavailable 7' })).toBeVisible();
    const order = canvas
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((text) => /^(All Photos|Favorites|Recent imports|RAW|Offloaded|Unavailable|Trash)/u.test(text))
      .map((text) => text.replace(/[\d,]+$/u, '').trim());
    await expect(order).toEqual(['All Photos', 'Favorites', 'Recent imports', 'RAW', 'Offloaded', 'Unavailable', 'Trash']);
  },
};

// #494 / ADR-0030 §2: a hidden album is marked in the row, and its actions
// menu discloses how many photos stay in All Photos via other albums and
// offers to open them.
export const HiddenAlbumDisclosesInclusion: Story = {
  args: {
    albums: [
      listing({
        id: 'a1',
        name: 'Iceland',
        count: 214,
        showInAllPhotos: false,
        visibleElsewhere: 12,
        visibleVia: [{ id: 'a2', name: 'Studio scans' }],
      }),
      listing({ id: 'a2', name: 'Studio scans', count: 1042, visibleElsewhere: 12 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Hidden from All Photos' })).toBeVisible();
    await openActions(canvas.getByRole('button', { name: 'Actions for Iceland' }));
    const body = within(document.body);
    await expect(body.getByRole('menuitem', { name: /Show in All Photos/u })).toBeVisible();
    await expect(body.getByRole('menuitem', { name: /12 photos stay in All Photos via other albums/u })).toBeVisible();
    await expect(body.getByRole('menuitem', { name: 'Open Studio scans' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

export const LockedProtectedAlbumLeaksNothing: Story = {
  args: {
    protectedAlbums: [{ id: 'opaque-protected-id', label: 'Protected album', locked: true, name: 'Family', count: 842 }],
    onProtectedOpen: fn(),
  },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Protected album' })).toBeVisible();
    await expect(canvas.queryByText('Family')).not.toBeInTheDocument();
    await expect(canvas.queryByText('842')).not.toBeInTheDocument();
  },
};

export const AlbumManagement: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      renameAlbum.mockClear();
      deleteAlbum.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const actions = canvas.getByRole('button', { name: 'Actions for Iceland' });
    await openActions(actions);
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Rename album…' }));
    const renameDialog = within(canvas.getByRole('dialog', { name: 'Rename album' }));
    await userEvent.clear(renameDialog.getByRole('textbox', { name: 'Album name' }));
    await userEvent.type(renameDialog.getByRole('textbox', { name: 'Album name' }), '  Iceland selects  ');
    await userEvent.click(renameDialog.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(renameAlbum).toHaveBeenCalledWith({ albumId: 'a1', name: 'Iceland selects' }));
    await waitFor(() => expect(actions).toHaveFocus());

    await userEvent.click(actions);
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Delete album…' }));
    const deleteDialog = within(canvas.getByRole('dialog', { name: 'Delete album' }));
    await expect(deleteDialog.getByText(/All 214 photos stay in your library/u)).toBeVisible();
    await userEvent.click(deleteDialog.getByRole('button', { name: 'Delete album' }));
    await waitFor(() => expect(deleteAlbum).toHaveBeenCalledWith({ albumId: 'a1' }));
  },
};

export const AlbumKeyboardReorder: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      reorderAlbum.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 2' });
    handle.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    await waitFor(() => expect(reorderAlbum).toHaveBeenCalledWith({ albumId: 'a1', position: 1, commandId: 'album.reorder.bottom' }));
    await expect(handle).toHaveFocus();
    await expect(canvas.getByRole('button', { name: 'Reorder Iceland, position 2 of 2' })).toBeVisible();
  },
};

export const AlbumPointerReorder: Story = {
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      reorderAlbum.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 2' });
    const studioRow = canvas.getByText('Studio scans').closest('.ovl-sidebar__albumrow');
    await expect(studioRow).not.toBeNull();
    if (studioRow === null) return;
    const transfer = dataTransfer();
    await fireEvent.dragStart(handle, { dataTransfer: transfer });
    await fireEvent.dragOver(studioRow, { dataTransfer: transfer, clientY: 10_000 });
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Reorder Iceland, position 2 of 2' })).toBeVisible());
    await fireEvent.drop(studioRow, { dataTransfer: transfer, clientY: 10_000 });
    await fireEvent.dragEnd(handle, { dataTransfer: transfer });
    await waitFor(() => expect(reorderAlbum).toHaveBeenCalledWith({ albumId: 'a1', position: 1, commandId: 'album.reorder.bottom' }));
  },
};

export const CollapsedAlbumKeyboardActions: Story = {
  loaders: [
    () => {
      window.localStorage.setItem(COLLAPSE_KEY, '1');
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const albumRow = canvas.getByRole('button', { name: 'Iceland · 214 · album 1 of 2' });
    albumRow.focus();
    await fireEvent.keyDown(albumRow, { key: 'F10', shiftKey: true });
    const menu = canvas.getByRole('menu', { name: 'Actions for Iceland' });
    const moveUp = within(menu).getByRole('menuitem', { name: 'Move up ⌥↑' });
    await expect(menu).toBeVisible();
    await expect(moveUp).toHaveFocus();
    await expect(moveUp).toHaveAttribute('aria-disabled', 'true');
  },
};

export const CollapsedAlbumKeyboardActionsWindows: Story = {
  args: { platform: 'win32' },
  loaders: [
    () => {
      window.localStorage.setItem(COLLAPSE_KEY, '1');
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const albumRow = canvas.getByRole('button', { name: 'Iceland · 214 · album 1 of 2' });
    albumRow.focus();
    await fireEvent.keyDown(albumRow, { key: 'F10', shiftKey: true });
    const menu = canvas.getByRole('menu', { name: 'Actions for Iceland' });
    await expect(within(menu).getByRole('menuitem', { name: 'Move up Alt+↑' })).toHaveFocus();
  },
};

function dataTransfer(): DataTransfer {
  return new DataTransfer();
}

function FolderDragHarness(args: ComponentProps<typeof Sidebar>) {
  const [rows, setRows] = useState(args.albums);
  useEffect(() => {
    const previous = window.overlook;
    const move: OverlookApi['albums']['move'] = async (request) => {
      const result = await moveAlbum(request);
      if (result?.refusal !== undefined) return { refusal: result.refusal };
      const source = rows.find((album) => album.id === request.albumId);
      if (source === undefined) throw new Error('missing story album');
      const moved = { ...source, parentId: request.parentId };
      setRows([...rows.filter((album) => album.id !== source.id), moved]);
      return { album: moved };
    };
    (globalThis as { overlook?: OverlookApi }).overlook = { ...previous, albums: { ...previous.albums, move } };
    return () => {
      endAlbumReorderDrag();
      (globalThis as { overlook?: OverlookApi }).overlook = previous;
    };
  }, [rows]);
  return <Sidebar {...args} albums={rows} />;
}

export const AlbumFolderDrag: Story = {
  args: {
    albums: [
      listing({ id: 'f1', name: 'Trips', count: 214, kind: 'folder' }),
      listing({ id: 'a1', name: 'Iceland', count: 214, parentId: 'f1' }),
      listing({ id: 'f2', name: 'Archive', count: 0, kind: 'folder' }),
    ],
  },
  render: (args) => <FolderDragHarness {...args} />,
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      window.localStorage.setItem('overlook.albumFoldersCollapsed', JSON.stringify(['f2']));
      moveAlbum.mockReset();
      moveAlbum.mockResolvedValueOnce({ refusal: 'depth' });
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 1' });
    const destination = canvas.getByText('Archive').closest('.ovl-sidebar__albumrow');
    if (destination === null) throw new Error('missing destination row');
    const bounds = destination.getBoundingClientRect();
    const center = bounds.top + bounds.height / 2;
    const transfer = dataTransfer();
    await expect(handle).toBeEnabled();
    await fireEvent.dragStart(handle, { dataTransfer: transfer });
    await fireEvent.dragOver(destination, { dataTransfer: transfer, clientY: center });
    await waitFor(() => expect(within(destination as HTMLElement).getByText('Move Iceland to Archive, position 1.')).toBeVisible());
    await waitFor(() =>
      expect(within(document.body).getByTestId('screen-reader-announcer-polite')).toHaveTextContent('Move Iceland to Archive, position 1.'),
    );
    await fireEvent.dragEnd(handle, { dataTransfer: transfer });
    await expect(moveAlbum).not.toHaveBeenCalled();
    await expect(handle).toHaveFocus();

    // Refusal preserves the old tree and names the main-process reason.
    await fireEvent.dragStart(handle, { dataTransfer: transfer });
    await fireEvent.dragOver(destination, { dataTransfer: transfer, clientY: center });
    await fireEvent.drop(destination, { dataTransfer: transfer, clientY: center });
    await fireEvent.dragEnd(handle, { dataTransfer: transfer });
    await waitFor(() =>
      expect(within(document.body).getByTestId('screen-reader-announcer-polite')).toHaveTextContent('albums nest at most 6 levels deep'),
    );
    await expect(handle).toHaveFocus();
    await expect(canvas.getByText('Iceland').closest('.ovl-sidebar__albumrow')).toHaveAttribute('data-depth', '1');

    // A successful move expands the collapsed destination and focuses the new row.
    await fireEvent.dragStart(handle, { dataTransfer: transfer });
    await fireEvent.dragOver(destination, { dataTransfer: transfer, clientY: center });
    await fireEvent.drop(destination, { dataTransfer: transfer, clientY: center });
    await fireEvent.dragEnd(handle, { dataTransfer: transfer });
    await waitFor(() => expect(moveAlbum).toHaveBeenLastCalledWith({ albumId: 'a1', parentId: 'f2', position: 0 }));
    await waitFor(() => expect(canvas.getByRole('button', { name: /^Archive/u })).toHaveAttribute('aria-expanded', 'true'));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 1' })).toHaveFocus());
    await waitFor(() =>
      expect(within(document.body).getByTestId('screen-reader-announcer-polite')).toHaveTextContent('Moved Iceland to Archive.'),
    );

    // Releasing at another zone of the same row must override its last hover.
    const movedHandle = canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 1' });
    const trips = canvas.getByText('Trips').closest('.ovl-sidebar__albumrow');
    if (trips === null) throw new Error('missing Trips row');
    const tripsBounds = trips.getBoundingClientRect();
    await fireEvent.dragStart(movedHandle, { dataTransfer: transfer });
    await fireEvent.dragOver(trips, { dataTransfer: transfer, clientY: tripsBounds.top + tripsBounds.height / 2 });
    await waitFor(() => expect(within(trips as HTMLElement).getByText('Move Iceland to Trips, position 1.')).toBeVisible());
    await fireEvent.drop(trips, { dataTransfer: transfer, clientY: tripsBounds.top + 1 });
    await fireEvent.dragEnd(movedHandle, { dataTransfer: transfer });
    await waitFor(() => expect(moveAlbum).toHaveBeenLastCalledWith({ albumId: 'a1', parentId: null, position: 0 }));
    await waitFor(() => expect(canvas.getByText('Iceland').closest('.ovl-sidebar__albumrow')).toHaveAttribute('data-depth', '0'));
  },
};

// #505 / ADR-0030 §1–§2: folders nest albums with one indent per level, the
// folder row discloses its children, a child following the folder's policy
// says so and can leave it, "Move to folder…" offers every other folder, and
// deleting a non-empty folder names exactly what goes with it — never photos.
export const AlbumFolders: Story = {
  args: {
    albums: [
      listing({ id: 'f1', name: 'Trips', count: 214, kind: 'folder', showInAllPhotos: false, tags: ['travel'] }),
      listing({ id: 'a1', name: 'Iceland', count: 214, parentId: 'f1', showInAllPhotos: false, inheritsVisibility: true }),
      listing({ id: 'f2', name: 'Archive', count: 0, kind: 'folder' }),
      listing({ id: 'a2', name: 'Studio scans', count: 1042 }),
    ],
  },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      window.localStorage.removeItem('overlook.albumFoldersCollapsed');
      moveAlbum.mockClear();
      deleteFolder.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const trips = canvas.getByRole('button', { name: /^Trips/u });
    await expect(trips).toHaveAttribute('aria-expanded', 'true');
    const iceland = canvas.getByText('Iceland').closest('.ovl-sidebar__albumrow');
    await expect(iceland).toHaveAttribute('data-depth', '1');
    await expect(canvas.getByRole('button', { name: 'Reorder Iceland, position 1 of 1' })).toBeEnabled();

    await openActions(canvas.getByRole('button', { name: 'Actions for Iceland' }));
    await expect(
      body.queryByRole('menuitem', { name: commandById('album.folder.newInside').label.defaultMessage }),
    ).not.toBeInTheDocument();
    await expect(
      body.queryByRole('menuitem', { name: commandById('album.folder.newAlbumInside').label.defaultMessage }),
    ).not.toBeInTheDocument();
    await expect(body.getByRole('menuitem', { name: /Show in All Photos.*Follows the folder setting/u })).toBeVisible();
    await expect(body.queryByRole('menuitem', { name: 'Use folder setting' })).not.toBeInTheDocument();
    await userEvent.click(body.getByRole('menuitem', { name: 'Move to folder…' }));
    const move = within(canvas.getByRole('dialog', { name: 'Move Iceland' }));
    await userEvent.selectOptions(move.getByRole('combobox', { name: 'Folder' }), 'Archive');
    await userEvent.click(move.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(moveAlbum).toHaveBeenCalledWith({ albumId: 'a1', parentId: 'f2' }));

    await userEvent.click(trips);
    await expect(trips).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByText('Iceland')).not.toBeInTheDocument();
    await userEvent.click(trips);
    await expect(canvas.getByText('Iceland')).toBeVisible();

    await openActions(canvas.getByRole('button', { name: 'Actions for Trips' }));
    await userEvent.click(body.getByRole('menuitem', { name: commandById('album.folder.newAlbumInside').label.defaultMessage }));
    const newAlbum = within(canvas.getByRole('dialog', { name: 'New album in Trips' }));
    await expect(newAlbum.getByRole('textbox', { name: 'Album name' })).toBeVisible();
    await userEvent.click(newAlbum.getByRole('button', { name: 'Cancel' }));

    await openActions(canvas.getByRole('button', { name: 'Actions for Trips' }));
    await userEvent.click(body.getByRole('menuitem', { name: commandById('album.folder.newInside').label.defaultMessage }));
    const newFolder = within(canvas.getByRole('dialog', { name: 'New folder in Trips' }));
    await expect(newFolder.getByRole('textbox', { name: 'Folder name' })).toBeVisible();
    await userEvent.click(newFolder.getByRole('button', { name: 'Cancel' }));

    await openActions(canvas.getByRole('button', { name: 'Actions for Trips' }));
    await expect(body.getByRole('menuitem', { name: /Tags….*travel/u })).toBeVisible();
    await userEvent.click(body.getByRole('menuitem', { name: 'Delete folder…' }));
    const remove = within(canvas.getByRole('dialog', { name: 'Delete folder' }));
    await expect(remove.getByText(/only the folder, the albums inside it, and their membership are removed/u)).toBeVisible();
    await userEvent.click(remove.getByRole('radio', { name: 'Also delete 1 album inside it' }));
    await userEvent.click(remove.getByRole('button', { name: 'Delete folder' }));
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith({ albumId: 'f1', folder: { mode: 'recursive' } }));
  },
};

// #1108: the fixed listing snapshot lets each deletion mode exercise the
// selection transition independently; database deletion is covered separately.
export const FolderDeletionSelection: Story = {
  args: {
    albums: [
      listing({ id: 'f1', name: 'Trips', count: 2, kind: 'folder' }),
      listing({ id: 'a1', name: 'Iceland', count: 1, parentId: 'f1' }),
      listing({ id: 'f2', name: 'Europe', count: 1, kind: 'folder', parentId: 'f1' }),
      listing({ id: 'a2', name: 'Paris', count: 1, parentId: 'f2' }),
      listing({ id: 's1', name: 'Travel query', count: 1, kind: 'smart', parentId: 'f2' }),
      listing({ id: 'a3', name: 'Studio', count: 1 }),
    ],
  },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      window.localStorage.removeItem('overlook.albumFoldersCollapsed');
      deleteFolder.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    for (const [name, recursive, survives] of [
      ['Iceland', false, true],
      ['Paris', false, true],
      ['Paris', true, false],
      ['Travel query', true, false],
      ['Studio', true, true],
    ] as const) {
      deleteFolder.mockClear();
      const selected = canvas.getByRole('button', { name: new RegExp(`^${name}\\b`, 'u') });
      await userEvent.click(selected);
      await expect(selected).toHaveClass('ovl-siderow--active');
      await openActions(canvas.getByRole('button', { name: 'Actions for Trips' }));
      await userEvent.click(body.getByRole('menuitem', { name: 'Delete folder…' }));
      const remove = within(canvas.getByRole('dialog', { name: 'Delete folder' }));
      if (recursive) await userEvent.click(remove.getByRole('radio', { name: /^Also delete/u }));
      await userEvent.click(remove.getByRole('button', { name: 'Delete folder' }));
      await waitFor(() =>
        expect(deleteFolder).toHaveBeenCalledWith({
          albumId: 'f1',
          folder: recursive ? { mode: 'recursive' } : { mode: 'move', destinationId: null },
        }),
      );
      await waitFor(() => expect(canvas.queryByRole('dialog', { name: 'Delete folder' })).not.toBeInTheDocument());
      if (survives) await expect(selected).toHaveClass('ovl-siderow--active');
      else {
        await expect(selected).not.toHaveClass('ovl-siderow--active');
        await expect(canvas.getByRole('button', { name: /^All Photos/u })).toHaveClass('ovl-siderow--active');
      }
    }
  },
};

export const AlbumDropStates: Story = {
  tags: ['album-drop'],
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      addPhotos.mockClear();
      movePhotos.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const iceland = canvas.getByText('Iceland').closest('.ovl-sidebar__albumrow');
    const studio = canvas.getByText('Studio scans').closest('.ovl-sidebar__albumrow');
    await expect(iceland).not.toBeNull();
    await expect(studio).not.toBeNull();
    if (iceland === null || studio === null) return;

    const addTransfer = dataTransfer();
    beginPhotoDrag(addTransfer, { version: 1, photoIds: ['P1', 'P2'], sourceAlbumId: null });
    await fireEvent.dragEnter(iceland, { dataTransfer: addTransfer });
    await waitFor(() => expect(canvas.getByText('Drop')).toBeVisible());
    await fireEvent.drop(iceland, { dataTransfer: addTransfer });
    await waitFor(() => expect(addPhotos).toHaveBeenCalledWith({ albumId: 'a1', photoIds: ['P1', 'P2'] }));
    await expect(canvas.getByText('Added')).toBeVisible();

    const moveTransfer = dataTransfer();
    beginPhotoDrag(moveTransfer, { version: 1, photoIds: ['P3'], sourceAlbumId: 'a1' });
    await fireEvent.drop(studio, { dataTransfer: moveTransfer });
    const choice = within(canvas.getByRole('dialog', { name: 'Add or move photo?' }));
    await expect(choice.getByText(/Add keeps the photo in both albums/u)).toBeVisible();
    await userEvent.click(choice.getByRole('button', { name: 'Move to Studio scans' }));
    await waitFor(() => expect(movePhotos).toHaveBeenCalledWith({ sourceAlbumId: 'a1', targetAlbumId: 'a2', photoIds: ['P3'] }));
    await expect(canvas.getByText('Moved')).toBeVisible();

    const noOpTransfer = dataTransfer();
    beginPhotoDrag(noOpTransfer, { version: 1, photoIds: ['P4'], sourceAlbumId: 'a1' });
    await fireEvent.dragEnter(iceland, { dataTransfer: noOpTransfer });
    await waitFor(() => expect(canvas.getByText('Already here')).toBeVisible());
    await fireEvent.drop(iceland, { dataTransfer: noOpTransfer });
    await expect(addPhotos).toHaveBeenCalledTimes(1);
    await expect(movePhotos).toHaveBeenCalledTimes(1);
  },
};

// #514 / ADR-0030 §3: a Smart Album row carries the funnel, its count is the
// query evaluated now, its menu edits or duplicates the query and never
// offers to hide membership it does not have, and a query this version
// cannot evaluate is marked rather than dropped.
export const SmartAlbums: Story = {
  args: {
    albums: [
      listing({ id: 'f1', name: 'Trips', count: 0, kind: 'folder' }),
      listing({
        id: 's1',
        name: 'Fuji RAW',
        count: 14,
        kind: 'smart',
        parentId: 'f1',
        predicate: { version: 1, composition: 'and', groups: [{ facet: 'camera', values: ['FUJIFILM X-T5'] }] },
      }),
      listing({
        id: 's2',
        name: 'From the future',
        count: 0,
        kind: 'smart',
        unsupported: 'predicate version 99 is newer than this app understands',
      }),
      listing({ id: 'a1', name: 'Family', count: 3 }),
    ],
  },
  loaders: [
    () => {
      window.localStorage.removeItem(COLLAPSE_KEY);
      window.localStorage.removeItem('overlook.albumFoldersCollapsed');
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole('listitem');
    await expect(rows.find((row) => row.textContent?.includes('Fuji RAW'))).toHaveAttribute('data-kind', 'smart');
    await expect(canvas.getByRole('img', { name: 'Saved query cannot be evaluated by this version' })).toBeInTheDocument();
    await openActions(canvas.getByRole('button', { name: 'Actions for Fuji RAW' }));
    const menu = canvas.getByRole('menu', { name: 'Actions for Fuji RAW' });
    await expect(within(menu).getByRole('menuitem', { name: 'Edit Smart Album' })).toBeInTheDocument();
    await expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    await expect(within(menu).getByRole('menuitem', { name: 'Delete Smart Album…' })).toBeInTheDocument();
    await expect(within(menu).queryByRole('menuitem', { name: /Hide from All Photos/u })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  },
};
