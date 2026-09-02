import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import { useEffect } from 'react';

import { Sidebar } from './Sidebar';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { AlbumSummary, LibraryStats, SourceCounts } from '../../../shared/library/types.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { beginPhotoDrag } from '../grid/photo-drag-session';

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
    delete: (request: unknown) => {
      deleteAlbum(request);
      return Promise.resolve({});
    },
    addPhotos,
    movePhotos,
    reorder: reorderAlbum,
  } as unknown as OverlookApi['albums'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library, backup, albums: albumActions };
}

const counts: SourceCounts = { all: 204318, favorites: 11, recent: 96, offloaded: 12, deleted: 3 };
const stats: LibraryStats = {
  photos: 204318,
  bytes: 1_580_000_000_000,
  pending: 0,
  lastBackupAt: null,
  offloadedBytes: 380_000_000_000,
};
const albums: readonly AlbumSummary[] = [
  { id: 'a1', name: 'Iceland', count: 214 },
  { id: 'a2', name: 'Studio scans', count: 1042 },
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
    actions.focus();
    await waitFor(() => expect(window.getComputedStyle(actions).pointerEvents).toBe('auto'));
    await userEvent.click(actions);
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
