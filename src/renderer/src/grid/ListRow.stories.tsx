import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';

import realPhoto from '../../../../design/handoff/assets/thumbs/t02.png';
import type { PhotoRecord, SyncStatus } from '../../../shared/library/types.js';
import { ListRow } from './ListRow';

const meta: Meta<typeof ListRow> = {
  title: 'Grid/ListRow',
  component: ListRow,
};

export default meta;
type Story = StoryObj<typeof ListRow>;

function photo(index: number, syncState: SyncStatus, favorite = false): PhotoRecord {
  return {
    id: `P${index}`,
    fileName: `IMG_${4021 + index}.JPG`,
    mediaInfo: null,
    fileKind: 'jpeg',
    width: 6240,
    height: 4160,
    bytes: 24_600_000,
    contentHash: `hash-${index}`,
    derivativeKey: `hash-${index}`,
    variantSourceId: null,
    assetOwnerId: null,
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
    favorite,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    syncState,
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

const STATES: readonly SyncStatus[] = ['local', 'synced', 'syncing', 'offloaded'];

function Matrix(): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 'var(--space-3)', maxWidth: 720 }}>
      {STATES.map((syncState, index) => (
        <div key={syncState} style={{ height: 52 }}>
          <ListRow
            photo={photo(index, syncState, index === 0)}
            src={realPhoto}
            selected={false}
            onOpen={fn()}
            onToggleSelect={fn()}
            onToggleFavorite={fn()}
          />
        </div>
      ))}
      <div style={{ height: 52 }}>
        <ListRow photo={photo(9, 'synced', true)} src={realPhoto} selected onOpen={fn()} onToggleSelect={fn()} onToggleFavorite={fn()} />
      </div>
    </div>
  );
}

export const StateMatrix: Story = {
  render: () => <Matrix />,
};

const onOpen = fn();
const onToggle = fn();
const onToggleFavorite = fn();
const onContextAction = fn();

// Same contract as PhotoTile (#77): the circle toggles without opening.
export const ClickTargetsAreIndependent: Story = {
  render: () => (
    <div style={{ height: 52, maxWidth: 720, padding: 'var(--space-3)' }}>
      <ListRow
        photo={photo(0, 'synced')}
        src={realPhoto}
        selected={false}
        onOpen={onOpen}
        onToggleSelect={onToggle}
        onToggleFavorite={onToggleFavorite}
        onContextAction={onContextAction}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole('button', { name: 'Open IMG_4021.JPG' });
    const circle = canvas.getByRole('button', { name: 'Select IMG_4021.JPG' });
    const status = canvas.getByRole('img', { name: 'Backed up (encrypted)' });
    await expect(row).not.toContainElement(circle);
    await expect(row).not.toContainElement(status);
    await expect(circle.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await expect(circle.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await userEvent.click(circle);
    await expect(onToggle).toHaveBeenCalledTimes(1);
    await expect(onOpen).not.toHaveBeenCalled();
    const favorite = canvas.getByRole('button', { name: 'Add to Favorites' });
    await expect(favorite).toHaveAttribute('aria-pressed', 'false');
    await expect(favorite.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await expect(favorite.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await userEvent.click(favorite);
    await expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    await expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(row);
    await expect(onOpen).toHaveBeenCalledTimes(1);

    row.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    await expect(onOpen).toHaveBeenCalledTimes(3);

    await fireEvent.keyDown(row, { key: 'ContextMenu' });
    await expect(onContextAction).toHaveBeenCalledOnce();
  },
};
