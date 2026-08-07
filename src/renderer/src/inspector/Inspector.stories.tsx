import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Inspector } from './Inspector';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { PhotoRecord } from '../../../shared/library/types.js';

// #94 exit criteria: §4 visual match — grouped truth rows, interpunct mono
// values, RAF → RAW badge, missing EXIF rows OMITTED (never fabricated).

const PHOTO: PhotoRecord = {
  id: '01J8SEEDPHOTO0000',
  fileName: 'IMG_4021.RAF',
  fileKind: 'raw',
  mediaInfo: null,
  width: 6240,
  height: 4160,
  bytes: 8_400_000,
  contentHash: 'a'.repeat(64),
  camera: 'FUJIFILM X-T5',
  lens: 'XF 35MM F/1.4',
  iso: 200,
  aperture: '1.4',
  shutter: '1/250',
  focalLength: 35,
  takenAt: '2026-06-12T12:34:56',
  gpsLat: null,
  gpsLon: null,
  place: 'Lisbon',
  importedAt: '2026-07-02T00:00:00.000Z',
  importSource: 'SD card',
  favorite: true,
  isOriginal: false,
  keyId: 2,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'verified',
  syncState: 'synced',
  title: 'Lisbon morning',
  description: 'Street scene near the waterfront.',
  tags: ['Lisbon', 'Travel'],
  userTags: ['Travel'],
  importedKeywords: ['Lisbon'],
  suppressedKeywords: [],
  metadataVersion: 1,
};

const meta: Meta<typeof Inspector> = {
  title: 'App/Inspector',
  component: Inspector,
  decorators: [
    (Story) => {
      const library = {
        metadataSummary: () =>
          Promise.resolve({
            found: 1,
            missing: 0,
            title: { mixed: false, value: PHOTO.title },
            description: { mixed: false, value: PHOTO.description },
            commonTags: PHOTO.tags,
            varyingTags: [],
          }),
        updateMetadata: () => Promise.resolve({ updated: 1, unchanged: 0, missing: 0, photoIds: [PHOTO.id] }),
        tagSuggestions: () =>
          Promise.resolve({
            tags: [
              { name: 'Lisbon', count: 1 },
              { name: 'Travel', count: 1 },
            ],
          }),
        manageTag: () => Promise.resolve({ updated: 1, unchanged: 0, missing: 0, photoIds: [PHOTO.id], merged: false }),
      } as unknown as OverlookApi['library'];
      (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library };
      return (
        <div style={{ width: 'var(--inspector-w)', height: 480, background: 'var(--gray-1)', borderLeft: '1px solid var(--border-1)' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof Inspector>;

export const RafFavorite: Story = {
  args: { photo: PHOTO, providerLabel: 'Local mock' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Inspector' })).toBeInTheDocument();
    await expect(canvas.getByRole('heading', { level: 3, name: 'Capture' })).toBeInTheDocument();
    await expect(canvas.getByText('raw')).toBeVisible();
    await expect(canvas.getByText('Encrypted')).toBeVisible();
    await expect(canvas.getByText('Favorite')).toBeVisible();
    await expect(canvas.getByText('Jun 12, 2026 · Lisbon')).toBeVisible();
    // Interpunct-joined mono values per the copy rules.
    await expect(canvas.getByText('ƒ/1.4 · 1/250S · ISO 200')).toBeVisible();
    await expect(canvas.getByText('6240×4160 · 26.0 MP')).toBeVisible();
    await expect(canvas.getByText('Jul 2, 2026 · SD card')).toBeVisible();
    // Real key metadata + the honest synced copy (no fabricated timestamp).
    await expect(canvas.getByText('AES-256-GCM · KEY #2')).toBeVisible();
    await expect(canvas.getByText('Encrypted · Local mock')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy filename' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy cipher identity' })).toBeVisible();
    await expect(canvas.queryByText('DIMENSIONS MISMATCH — POSSIBLY CORRUPT METADATA')).toBeNull();
  },
};

export const MetadataLite: Story = {
  args: {
    photo: {
      ...PHOTO,
      fileKind: 'jpeg',
      fileName: 'scan-0001.jpg',
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      place: null,
      favorite: false,
      syncState: 'local',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Missing EXIF rows are OMITTED — never fabricated.
    await expect(canvas.queryByText('Camera')).toBeNull();
    await expect(canvas.queryByText('Exposure')).toBeNull();
    await expect(canvas.queryByText('Favorite')).toBeNull();
    await expect(canvas.getByText('jpeg')).toBeVisible();
    await expect(canvas.getByText('Local only — not backed up')).toBeVisible();
  },
};

export const UnknownDimensions: Story = {
  args: { photo: { ...PHOTO, width: 0, height: 0, fileName: 'legacy-zero.jpg' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Unknown — repair pending')).toBeVisible();
    await expect(canvas.queryByText('0×0 · 0.0 MP')).toBeNull();
  },
};

export const PossiblyCorruptMetadata: Story = {
  args: {
    photo: {
      ...PHOTO,
      fileKind: 'jpeg',
      fileName: 'metadata-mismatch.jpg',
      dimensionStatus: 'metadata-mismatch',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Metadata')).toBeVisible();
    await expect(canvas.getByText('DIMENSIONS MISMATCH — POSSIBLY CORRUPT METADATA')).toBeVisible();
    await expect(canvas.getByText('6240×4160 · 26.0 MP')).toBeVisible();
  },
};

export const Empty: Story = {
  args: { photo: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Select a photo')).toBeVisible();
  },
};

export const MultipleSelected: Story = {
  args: {
    photo: PHOTO,
    selectionPosition: { index: 1, count: 3 },
    onPrevious: fn(),
    onNext: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('2 of 3 selected')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous selected photo' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next selected photo' }));
    await expect(args.onPrevious).toHaveBeenCalledTimes(1);
    await expect(args.onNext).toHaveBeenCalledTimes(1);
  },
};

export const EditableMetadata: Story = {
  args: { photo: PHOTO },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByDisplayValue('Lisbon morning')).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('Title'));
    await userEvent.type(canvas.getByLabelText('Title'), 'Lisbon dusk');
    await userEvent.type(canvas.getByLabelText('Add tag'), 'Portfolio{enter}');
    await expect(canvas.getByRole('button', { name: 'Remove Portfolio' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Save metadata' }));
    await expect(await canvas.findByText('Updated 1; 0 unchanged; 0 unavailable.')).toBeVisible();
  },
};
