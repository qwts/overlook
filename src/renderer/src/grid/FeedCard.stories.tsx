import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import realPhoto from '../../../../design/handoff/assets/thumbs/t02.png';
import wide from '../../../../design/handoff/assets/thumbs/t01.png';
import type { PhotoRecord, SyncStatus } from '../../../shared/library/types.js';
import type { VideoTileProps } from '../media/device-capabilities.js';
import { FeedCard } from './FeedCard';

// #516: the feed card's title / image / description contract, its missing
// title and description states, the offloaded and unavailable states, and
// the same independent click targets as ListRow and PhotoTile.

const meta: Meta<typeof FeedCard> = {
  title: 'Grid/FeedCard',
  component: FeedCard,
};

export default meta;
type Story = StoryObj<typeof FeedCard>;

const CARD_HEIGHT = 536; // VirtualGrid FEED_CARD_HEIGHT

function photo(index: number, syncState: SyncStatus, patch: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id: `P${index}`,
    fileName: `IMG_${4021 + index}.JPG`,
    mediaInfo: null,
    fileKind: 'jpeg',
    width: 6240,
    height: 4160,
    bytes: 24_600_000,
    contentHash: `hash-${index}`,
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
    syncState,
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
    ...patch,
  };
}

const TITLED = photo(0, 'synced', {
  title: 'Evening at the Tagus',
  description: 'The last ferry of the day crossing towards Cacilhas, shot from the Cais do Sodré pier while the light went orange.',
  favorite: true,
});

function Card({
  record,
  src = realPhoto,
  selected = false,
  media = null,
}: {
  record: PhotoRecord;
  src?: string;
  selected?: boolean;
  media?: VideoTileProps | null;
}): ReactElement {
  return (
    <div style={{ height: CARD_HEIGHT, maxWidth: 720 }}>
      <FeedCard
        photo={record}
        src={src}
        fullSrc={src}
        media={media}
        selected={selected}
        onOpen={fn()}
        onToggleSelect={fn()}
        onToggleFavorite={fn()}
      />
    </div>
  );
}

export const TitledWithDescription: Story = {
  render: () => <Card record={TITLED} src={wide} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Evening at the Tagus')).toBeVisible();
    // With a title, the file name moves into the meta line.
    await expect(canvas.getByText(/IMG_4021\.JPG · .*Lisbon · FUJIFILM X-T5/u)).toBeVisible();
    await expect(canvas.getByText(/The last ferry of the day/u)).toBeVisible();
    await waitFor(() => expect(canvasElement.querySelector('.ovl-feedcard__frame')).toHaveAttribute('data-state', 'loaded'));
  },
};

export const UntitledWithoutDescription: Story = {
  render: () => <Card record={photo(1, 'local')} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = canvas.getByText('IMG_4022.JPG');
    await expect(title).toHaveClass('ovl-feedcard__title--fallback');
    await expect(canvas.getByText('No description')).toHaveClass('ovl-feedcard__description--empty');
    await expect(canvas.getByText(/Lisbon · FUJIFILM X-T5/u)).not.toHaveTextContent('IMG_4022.JPG');
  },
};

export const Offloaded: Story = {
  render: () => <Card record={photo(2, 'offloaded', { title: 'Offloaded to the archive' })} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.ovl-feedcard')).toHaveClass('ovl-feedcard--offloaded');
    await expect(within(canvasElement).getByRole('img', { name: 'Offloaded' })).toBeVisible();
  },
};

export const PreviewUnavailable: Story = {
  render: () => <Card record={photo(3, 'synced', { previewFailure: 'corrupt' })} src="/missing-feed-preview.png" />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.ovl-feedcard__frame')).toHaveAttribute('data-state', 'unavailable'));
    await expect(canvasElement.querySelector('.ovl-feedcard__unavailable')).not.toHaveTextContent('');
  },
};

// Audio and still-probing media have no derivatives: the frame shows the
// kind glyph (PhotoTile's placeholder contract), never the unavailable copy.
export const AudioPlaceholder: Story = {
  render: () => (
    <Card
      record={photo(4, 'synced', { fileKind: 'audio', fileName: 'REC_0007.M4A' })}
      src="/missing-feed-preview.png"
      media={{ duration: null, preserved: false, placeholder: 'audio' }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.ovl-feedcard__frame')).toHaveAttribute('data-state', 'placeholder');
    await expect(canvasElement.querySelector('.ovl-feedcard__placeholder')).toBeVisible();
    await expect(canvasElement.querySelector('.ovl-feedcard__unavailable')).toBeNull();
  },
};

// A video whose poster is not captured yet falls back to the film glyph.
export const VideoAwaitingPoster: Story = {
  render: () => (
    <Card
      record={photo(5, 'synced', { fileKind: 'video', fileName: 'CLIP_0012.MOV' })}
      src="/missing-feed-poster.png"
      media={{ duration: 12, preserved: false, placeholder: 'video' }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.ovl-feedcard__frame')).toHaveAttribute('data-state', 'fallback'));
    await expect(canvasElement.querySelector('.ovl-feedcard__placeholder--fallback')).toBeVisible();
    await expect(canvasElement.querySelector('.ovl-feedcard__unavailable')).toHaveTextContent('');
  },
};

export const Selected: Story = {
  render: () => <Card record={TITLED} selected />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Deselect IMG_4021.JPG' })).toHaveAttribute('aria-pressed', 'true');
    await expect(canvasElement.querySelector('.ovl-feedcard')).toHaveClass('ovl-feedcard--selected');
  },
};

const onOpen = fn();
const onToggle = fn();
const onToggleFavorite = fn();
const onContextAction = fn();

// Same contract as ListRow and PhotoTile: the circle and the star never open.
export const ClickTargetsAreIndependent: Story = {
  render: () => (
    <div style={{ height: CARD_HEIGHT, maxWidth: 720 }}>
      <FeedCard
        photo={TITLED}
        src={realPhoto}
        fullSrc={realPhoto}
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
    const open = await canvas.findByRole('button', { name: 'Open IMG_4021.JPG' });
    const circle = canvas.getByRole('button', { name: 'Select IMG_4021.JPG' });
    await expect(open).not.toContainElement(circle);
    await expect(circle.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await userEvent.click(circle);
    await expect(onToggle).toHaveBeenCalledTimes(1);
    await expect(onOpen).not.toHaveBeenCalled();
    const favorite = canvas.getByRole('button', { name: 'Remove from Favorites' });
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(favorite);
    await expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    await expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(open);
    await expect(onOpen).toHaveBeenCalledTimes(1);

    open.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    await expect(onOpen).toHaveBeenCalledTimes(3);

    await fireEvent.keyDown(open, { key: 'ContextMenu' });
    await expect(onContextAction).toHaveBeenCalledOnce();

    // The title and description paint above the open button but never
    // intercept it (PR #1110 review): a pointer on the text hits the button.
    for (const text of ['Evening at the Tagus', /The last ferry of the day/u]) {
      const rect = canvas.getByText(text).getBoundingClientRect();
      await expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)).toBe(open);
    }
  },
};
