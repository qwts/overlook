import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { LightboxVideo } from './LightboxVideo';
import type { PhotoRecord } from '../../../shared/library/types.js';
import type { MediaInfo } from '../../../shared/library/media-info.js';
import type { DeviceMediaCapabilities } from '../../../shared/library/playability.js';

// #548 / ADR-0026 §5/§7 — the full-viewer video surface. MPEG-TS resolves
// preserved-only on this device until the §5 remux adapter lands, so the live
// transport is exercised here with injected playable capabilities.

const TS_INFO: MediaInfo = {
  animated: false,
  frameCount: null,
  loopCount: null,
  container: 'MPEG-TS',
  streams: [
    { type: 'video', codec: 'H.264', profile: null },
    { type: 'audio', codec: 'AAC', profile: null },
  ],
  durationSeconds: 128,
  codedWidth: null,
  codedHeight: null,
  displayWidth: null,
  displayHeight: null,
  rotationDegrees: null,
  frameRate: null,
  variableFrameRate: false,
  audioPresent: true,
  hdr: null,
  colorTransfer: null,
  probeIncomplete: false,
};

const VIDEO: PhotoRecord = {
  id: '01J8SEEDVIDEO0001',
  fileName: 'IMG_4021.ts',
  fileKind: 'video',
  mediaInfo: TS_INFO,
  width: 0,
  height: 0,
  bytes: 42_000_000,
  contentHash: 'b'.repeat(64),
  derivativeKey: 'b'.repeat(64),
  variantSourceId: null,
  assetOwnerId: null,
  camera: null,
  lens: null,
  iso: null,
  aperture: null,
  shutter: null,
  focalLength: null,
  takenAt: '2026-06-03T09:00:00',
  gpsLat: null,
  gpsLon: null,
  place: 'Big Sur',
  importedAt: '2026-07-01T00:00:00.000Z',
  importSource: 'seed',
  favorite: false,
  isOriginal: false,
  keyId: 1,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'unavailable',
  syncState: 'local',
  title: null,
  description: null,
  tags: [],
  userTags: [],
  importedKeywords: [],
  suppressedKeywords: [],
  metadataVersion: 1,
};

const PLAYABLE: DeviceMediaCapabilities = { canDecodeCodec: () => true, transportStreamRemuxAvailable: true };
const PRESERVED: DeviceMediaCapabilities = { canDecodeCodec: () => true, transportStreamRemuxAvailable: false };

const meta: Meta<typeof LightboxVideo> = {
  title: 'Lightbox/Video',
  component: LightboxVideo,
  args: {
    photo: VIDEO,
    src: 'about:blank',
    chromeVisible: true,
    onActivity: fn(),
    onExport: fn(),
    onTransfer: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 720, height: 405, background: 'var(--gray-0)' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof LightboxVideo>;

// Playable on this device: the rest state shows a single center Play; nothing
// autostarts, no <video> has mounted its source yet.
export const PlayableRest: Story = {
  args: { capabilities: PLAYABLE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('group', { name: 'Video player — IMG_4021.ts' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Play video' })).toBeVisible();
    // Never autostarts: source is not attached until play.
    await expect(canvasElement.querySelector('video')?.getAttribute('src')).toBeNull();
  },
};

// Preserved-only on this device (no remux adapter): honest statement, no Play,
// every custody action present and enabled.
export const PreservedOnly: Story = {
  args: { capabilities: PRESERVED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: "Can't play on this device" })).toBeVisible();
    await expect(canvas.getByText(/This H\.264 video is saved and protected/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Export original' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Move to Image Trail' })).toBeEnabled();
    await expect(canvas.queryByRole('button', { name: 'Play video' })).toBeNull();
  },
};
