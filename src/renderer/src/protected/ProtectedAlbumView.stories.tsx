import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import flower from '../../../../tests/fixtures/photos/flower-landscape.jpg';
import street from '../../../../tests/fixtures/photos/street-city.jpg';
import square from '../../../../tests/fixtures/photos/street-square.jpg';
import summer from '../../../../tests/fixtures/photos/summer-landscape.jpg';
import type { ProtectedPhotoRecord } from '../../../shared/library/protected-types.js';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import { AppStateProvider } from '../state/app-state-context';
import { ProtectedAlbumView } from './ProtectedAlbumView';

const NAMES = ['flower-landscape.jpg', 'street-city.jpg', 'street-square.jpg', 'summer-landscape.jpg'] as const;
const PHOTOS: readonly ProtectedPhotoRecord[] = NAMES.map((fileName, index) => ({
  id: `protected-photo-${String(index + 1)}`,
  fileName,
  fileKind: 'jpeg',
  mediaInfo: null,
  width: 1200,
  height: 800,
  bytes: 2_400_000,
  derivativeKey: String(index + 1).padStart(64, '0'),
  variantSourceId: null,
  assetOwnerId: null,
  camera: 'FUJIFILM X-T5',
  lens: 'XF 35MM F/1.4',
  iso: 200,
  aperture: '2.8',
  shutter: '1/250',
  focalLength: 35,
  takenAt: `2026-07-${String(index + 10).padStart(2, '0')}T12:00:00.000Z`,
  gpsLat: null,
  gpsLon: null,
  place: null,
  importedAt: '2026-07-16T12:00:00.000Z',
  importSource: 'storybook-real-photo',
  favorite: index === 0,
  deletedAt: null,
  title: null,
  description: null,
  tags: [],
  userTags: [],
  importedKeywords: [],
  suppressedKeywords: [],
  metadataVersion: 1,
}));

const SOURCES = [flower, street, square, summer] as const;
const onRelocked = fn();

function installStub(): void {
  const protectedAlbums = {
    summary: () =>
      Promise.resolve({ id: 'opaque-album', name: 'Kyoto Spring', count: PHOTOS.length, createdAt: '2026-07-01T00:00:00.000Z' }),
    page: () => Promise.resolve({ photos: PHOTOS, nextCursor: null }),
    relock: () => Promise.resolve({ relocked: true }),
    toggleFavorite: ({ photoId }: { photoId: string }) => Promise.resolve({ favorite: photoId !== PHOTOS[0]?.id }),
    onChanged: () => () => undefined,
  } as unknown as OverlookApi['protectedAlbums'];
  const library = { onPendingCountChanged: () => () => undefined } as unknown as OverlookApi['library'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { protectedAlbums, library };
}

const meta: Meta<typeof ProtectedAlbumView> = {
  title: 'App/ProtectedAlbumView',
  component: ProtectedAlbumView,
  args: {
    albumId: 'opaque-album',
    onRelocked,
    mediaSrc: (photo) => SOURCES[PHOTOS.findIndex((candidate) => candidate.id === photo.id)] ?? flower,
  },
  decorators: [
    (Story) => {
      installStub();
      return (
        <AppStateProvider>
          <div style={{ width: 900, height: 600 }}>
            <Story />
          </div>
        </AppStateProvider>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ProtectedAlbumView>;

export const SessionUnlockedWithRealPhotos: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Kyoto Spring')).toBeVisible());
    await expect(canvas.getByText('4 photos')).toBeVisible();
    const tile = canvas.getByRole('button', { name: 'Open flower-landscape.jpg' });
    const thumbnail = tile.parentElement?.querySelector('.ovl-tile__img');
    await expect(thumbnail).toHaveAttribute('src', flower);
    const removeFavorite = canvas.getByRole('button', { name: 'Remove from Favorites' });
    await expect(removeFavorite).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(removeFavorite);
    await waitFor(() =>
      expect(within(tile.parentElement ?? canvasElement).getByRole('button', { name: 'Add to Favorites' })).toHaveAttribute(
        'aria-pressed',
        'false',
      ),
    );
    await userEvent.click(tile);
    const lightbox = canvas.getByRole('dialog', { name: 'Viewing flower-landscape.jpg' });
    await expect(within(lightbox).getByRole('img')).toHaveAttribute('src', flower);
    await expect(lightbox).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('dialog', { name: 'Viewing flower-landscape.jpg' })).not.toBeInTheDocument();
    await expect(tile).toHaveFocus();
  },
};

export const ManualRelockClearsRoute: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Relock' })).toBeVisible());
    onRelocked.mockClear();
    await userEvent.click(canvas.getByRole('button', { name: 'Relock' }));
    await waitFor(() => expect(onRelocked).toHaveBeenCalledOnce());
    await expect(canvas.queryByRole('img', { name: 'flower-landscape.jpg' })).not.toBeInTheDocument();
  },
};
