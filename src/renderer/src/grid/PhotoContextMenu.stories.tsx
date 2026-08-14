import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { PhotoRecord } from '../../../shared/library/types.js';
import { PhotoContextMenu } from './PhotoContextMenu';

const PHOTO: PhotoRecord = {
  id: 'context-photo',
  fileName: 'IMG_4021.JPG',
  fileKind: 'jpeg',
  width: 6240,
  height: 4160,
  bytes: 24_600_000,
  contentHash: 'context-photo-hash',
  camera: 'FUJIFILM X-T5',
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: '2026-06-12T12:00:00.000Z',
  gpsLat: null,
  gpsLon: null,
  place: 'Lisbon',
  importedAt: '2026-07-01T00:00:00.000Z',
  importSource: 'story',
  favorite: false,
  isOriginal: false,
  keyId: 1,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'verified',
  mediaInfo: null,
  syncState: 'synced',
  title: null,
  description: null,
  tags: [],
  userTags: [],
  importedKeywords: [],
  suppressedKeywords: [],
  metadataVersion: 1,
};

const meta: Meta<typeof PhotoContextMenu> = {
  title: 'Grid/PhotoContextMenu',
  component: PhotoContextMenu,
  args: {
    photo: PHOTO,
    targetCount: 2,
    inAlbum: true,
    x: 24,
    y: 24,
    onOpen: fn(),
    onToggleFavorite: fn(),
    onExport: fn(),
    onAddToAlbum: fn(),
    onRemoveFromAlbum: fn(),
    onOffload: fn(),
    onRestoreOriginal: fn(),
    onTransfer: fn(),
    onTrash: fn(),
    onRestore: fn(),
    onPurge: fn(),
    onClose: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof PhotoContextMenu>;

export const SelectionActionsAndKeyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole('menu', { name: 'Actions for 2 selected photos' });
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(9);
    await expect(within(menu).getByRole('menuitem', { name: 'Open' })).toHaveFocus();
    menu.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(within(menu).getByRole('menuitem', { name: 'Move photo to Trash' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await userEvent.keyboard('{ArrowUp}');
    await expect(within(menu).getByRole('menuitem', { name: 'Move photo to Trash' })).toHaveFocus();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from album' }));
    await expect(args.onRemoveFromAlbum).toHaveBeenCalledOnce();
  },
};

export const TrashActions: Story = {
  args: { photo: { ...PHOTO, deletedAt: '2026-07-20T00:00:00.000Z' }, targetCount: 1, inAlbum: false },
  play: async ({ canvasElement }) => {
    const menu = within(canvasElement).getByRole('menu', { name: 'Actions for IMG_4021.JPG' });
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    await expect(within(menu).getByRole('menuitem', { name: 'Restore photo' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Delete permanently…' })).toBeVisible();
  },
};
