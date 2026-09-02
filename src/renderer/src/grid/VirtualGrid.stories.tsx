import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import flowerPhoto from '../../../../design/handoff/assets/thumbs/t03.png';
import landscapePhoto from '../../../../design/handoff/assets/thumbs/t01.png';
import portraitPhoto from '../../../../design/handoff/assets/thumbs/t02.png';
import streetPhoto from '../../../../design/handoff/assets/thumbs/t04.png';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { PhotoTile } from '../components/PhotoTile';
import { VirtualGrid } from './VirtualGrid';

const meta: Meta<typeof VirtualGrid> = {
  title: 'Grid/VirtualGrid',
  component: VirtualGrid,
};

export default meta;
type Story = StoryObj<typeof VirtualGrid>;

const THUMBS = [landscapePhoto, portraitPhoto, flowerPhoto, streetPhoto] as const;

function photo(index: number): PhotoRecord {
  return {
    id: `P${index}`,
    fileName: `IMG_${index}.JPG`,
    fileKind: 'jpeg',
    mediaInfo: null,
    width: 200,
    height: 200,
    bytes: 1000,
    contentHash: `hash-${index}`,
    derivativeKey: `hash-${index}`,
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-01T00:00:00.000Z',
    importSource: 'story',
    favorite: index % 9 === 0,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    syncState: 'synced',
    coverage: 'included',
    locked: false,
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
  };
}

const PHOTOS = Array.from({ length: 60 }, (_, index) => photo(index));

const onOpen = fn();
const onToggle = fn();
const onKeyboardOpen = fn();
const onKeyboardSelection = fn();

// #76 exit criteria: interaction tests for tile click vs select-circle AT
// THE GRID LEVEL — the events must survive the engine's absolute-positioned
// cell wrapping, not just the bare component (PhotoTile.stories covers that).
export const TileClickVsSelectCircle: Story = {
  render: () => (
    <div style={{ position: 'relative', height: 420 }}>
      <VirtualGrid
        photos={PHOTOS}
        total={PHOTOS.length}
        zoom={140}
        onNeedMore={fn()}
        renderTile={(record, _size, keyboard) => (
          <PhotoTile
            src={THUMBS[Number(record.id.slice(1)) % THUMBS.length] ?? landscapePhoto}
            alt={record.fileName}
            favorite={record.favorite}
            onToggleFavorite={fn()}
            status={record.syncState}
            onClick={() => {
              onOpen(record.id);
            }}
            onToggleSelect={() => {
              onToggle(record.id);
            }}
            {...keyboard}
          />
        )}
        onKeyboardOpen={(record) => {
          onKeyboardOpen(record.id);
        }}
        onKeyboardSelection={onKeyboardSelection}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('list', { name: 'Photos' });
    const firstItem = canvas.getAllByRole('listitem')[0];
    await expect(firstItem).toHaveAttribute('aria-posinset', '1');
    await expect(firstItem).toHaveAttribute('aria-setsize', String(PHOTOS.length));
    const tile = await canvas.findByRole('button', { name: 'Open IMG_0.JPG' });
    const circle = within(tile.parentElement ?? canvasElement).getByRole('button', { name: 'Select IMG_0.JPG' });
    await expect(tile).not.toContainElement(circle);
    await userEvent.click(circle);
    await expect(onToggle).toHaveBeenCalledWith('P0');
    await expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(tile);
    await expect(onOpen).toHaveBeenCalledWith('P0');

    tile.focus();
    await userEvent.keyboard('{ArrowRight}');
    const second = canvas.getByRole('button', { name: 'Open IMG_1.JPG' });
    await waitFor(() => expect(second).toHaveFocus());
    await expect(tile).toHaveAttribute('tabindex', '-1');
    await expect(second).toHaveAttribute('tabindex', '0');

    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    const third = canvas.getByRole('button', { name: 'Open IMG_2.JPG' });
    await waitFor(() => expect(third).toHaveFocus());
    await expect(onKeyboardSelection).toHaveBeenCalledWith('P2', true);
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await expect(onKeyboardSelection).toHaveBeenCalledWith('P3', true);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Open IMG_3.JPG' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(onKeyboardOpen).toHaveBeenCalledWith('P3');
  },
};

// Windowing sanity in a real browser: far fewer cells mounted than photos.
export const WindowsLargeLibraries: Story = {
  render: () => (
    <div style={{ position: 'relative', height: 420 }}>
      <VirtualGrid photos={PHOTOS} total={100_000} zoom={96} onNeedMore={fn()} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByTestId('virtual-grid');
    const cells = canvasElement.querySelectorAll('.ovl-grid__cell');
    await expect(cells.length).toBeGreaterThan(0);
    await expect(cells.length).toBeLessThan(500);
  },
};
