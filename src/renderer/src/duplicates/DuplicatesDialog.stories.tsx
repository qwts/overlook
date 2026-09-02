import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { PhotoRecord } from '../../../shared/library/types.js';
import { DuplicatesDialog } from './DuplicatesDialog';

// Review Duplicates (#650): a group with a recompressed copy and a rotated
// copy of one photo, one member marked Original (its Trash control is
// disabled — #482 protection, surfaced rather than hidden), and the empty
// and still-indexing states.

function photo(id: string, overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1280,
    height: 853,
    bytes: 412_000,
    contentHash: `hash-${id}`,
    derivativeKey: `hash-${id}`,
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: '2026-07-14T10:00:00.000Z',
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-20T17:00:00.000Z',
    importSource: 'story',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'decoded',
    mediaInfo: null,
    syncState: 'local',
    ...overrides,
  } as PhotoRecord;
}

const REVIEW = {
  version: 'dhash-9x8-v1',
  threshold: 10,
  status: { total: 6, indexed: 6, deferred: 0, pending: 0 },
  groups: [
    {
      id: 'IMG_0001',
      photos: [
        photo('IMG_0001', { isOriginal: true, bytes: 2_400_000, width: 4032, height: 3024 }),
        photo('IMG_0001-web', { width: 1280, height: 960, bytes: 310_000 }),
        photo('IMG_0001-turned', { width: 3024, height: 4032, bytes: 2_100_000 }),
      ],
      pairs: [
        { left: 'IMG_0001', right: 'IMG_0001-web', distance: 1, rotation: 0 as const },
        { left: 'IMG_0001', right: 'IMG_0001-turned', distance: 4, rotation: 90 as const },
      ],
    },
  ],
};

const EMPTY = { ...REVIEW, groups: [], status: { total: 6, indexed: 6, deferred: 1, pending: 0 } };
const INDEXING = { ...REVIEW, groups: [], status: { total: 6, indexed: 2, deferred: 0, pending: 4 } };

type DuplicatesDialogApi = NonNullable<Parameters<typeof DuplicatesDialog>[0]['api']>;

const subscribe = () => () => undefined;
const remove = fn(() => Promise.resolve({ deleted: 1, protected: 0, missing: 0 }));

function apiFor(review: typeof REVIEW | typeof EMPTY): DuplicatesDialogApi {
  return {
    duplicates: { review: () => Promise.resolve(review), rescan: () => Promise.resolve(review.status), onChanged: subscribe },
    library: { delete: remove, onChanged: subscribe, onOriginalClassificationChanged: subscribe },
  } as unknown as DuplicatesDialogApi;
}

const meta: Meta<typeof DuplicatesDialog> = {
  title: 'Library/DuplicatesDialog',
  component: DuplicatesDialog,
  args: { open: true, onClose: fn(), dispatch: fn() },
};

export default meta;

type Story = StoryObj<typeof DuplicatesDialog>;

export const Group: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(REVIEW)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = await canvas.findByTestId('duplicates-dialog');
    await waitFor(() => expect(body).toHaveAttribute('data-state', 'ready'));
    await expect(body).toHaveAttribute('data-groups', '1');
    const group = canvas.getByTestId('duplicate-group');
    await expect(group).toHaveAttribute('data-count', '3');
    await expect(canvas.getByText('Near-identical · 1 of 64 bits differ')).toBeVisible();
    await expect(canvas.getByText('Very similar · rotated 90° · 4 of 64 bits differ')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Move IMG_0001.jpg to Trash' })).toBeDisabled();
    await expect(canvas.getByText('Original')).toBeVisible();
  },
};

export const TrashRoutesThroughTheLibrary: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(REVIEW)} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    remove.mockClear();
    await canvas.findByTestId('duplicate-group');
    await userEvent.click(canvas.getByRole('button', { name: 'Move IMG_0001-web.jpg to Trash' }));
    await expect(remove).toHaveBeenCalledWith({ photoIds: ['IMG_0001-web'] });
    await expect(args.dispatch).toHaveBeenCalledWith({
      type: 'toast/shown',
      toast: { title: 'Moved IMG_0001-web.jpg to Trash', tone: 'neutral' },
    });
  },
};

export const Clean: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(EMPTY)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No possible duplicates found.')).toBeVisible();
    await expect(canvas.getByText('1 photo has no preview to compare yet')).toBeVisible();
  },
};

export const StillIndexing: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(INDEXING)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = await canvas.findByTestId('duplicates-dialog');
    await waitFor(() => expect(body).toHaveAttribute('data-state', 'indexing'));
    await expect(canvas.getByText('Still comparing previews — nothing to review yet.')).toBeVisible();
    await expect(canvas.getByTestId('duplicates-progress')).toHaveTextContent('2 of 6 photos compared · 4 pending');
  },
};
